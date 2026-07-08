"""
Populate Qdrant with subtopic name embeddings and STN teaching contexts.
Supports checkpointing via course_bootstrap/<course>/qdrant_progress.json.

Usage:
    python scripts/populate_qdrant.py EE                         # populate EE course
    python scripts/populate_qdrant.py EE --force                  # re-populate from scratch
    python scripts/populate_qdrant.py EE --module module_1_dc    # only one module
    python scripts/populate_qdrant.py --all                       # all courses
"""

import json
import logging
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("populate_qdrant")

import config
from vector_db_service import VectorDBService

_COURSE_BOOTSTRAP = os.path.abspath(
    os.getenv(
        "COURSE_BOOTSTRAP_DIR",
        os.path.join(os.path.dirname(__file__), "..", "..", "course_bootstrap"),
    )
)


def _load_progress(course: str) -> dict:
    path = os.path.join(_COURSE_BOOTSTRAP, course, "qdrant_progress.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {"subtopic_names_done": [], "stn_notes_done": []}


def _save_progress(course: str, progress: dict):
    path = os.path.join(_COURSE_BOOTSTRAP, course, "qdrant_progress.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(progress, f, indent=2)
    os.replace(tmp, path)


def _get_subtopics(course: str) -> list:
    """Fetch all subtopics from Neo4j with their module/topic context."""
    try:
        from curriculum_graph_handler import traverse_curriculum
        curriculum = traverse_curriculum(course)
        entries = []
        for m in curriculum.get("modules", []):
            for t in m.get("topics", []):
                for s in t.get("subtopics", []):
                    entries.append({
                        "subtopic_id": s.get("id", ""),
                        "subtopic_name": s.get("name", ""),
                        "topic_id": t.get("id", ""),
                        "topic_name": t.get("name", ""),
                        "module_id": m.get("id", ""),
                        "module_name": m.get("name", ""),
                        "course": course,
                    })
        logger.info(f"Found {len(entries)} subtopics for '{course}'")
        return entries
    except ImportError:
        logger.error("Cannot import curriculum_graph_handler — is RAG service running?")
        return []
    except Exception as e:
        logger.error(f"Failed to fetch curriculum: {e}")
        return []


def _make_subtopic_chunk_text(sub: dict) -> str:
    """Create a meaningful text chunk from a subtopic entry."""
    parts = [
        f"Course: {sub['course']}",
        f"Module: {sub['module_name']}",
        f"Topic: {sub['topic_name']}",
        f"Subtopic: {sub['subtopic_name']}",
    ]
    return "\n".join(parts)


def populate_subtopic_names(course: str, vds: VectorDBService, progress: dict, subtopics: list) -> int:
    """Embed subtopic name+context and push to main Qdrant collection."""
    done_ids = set(progress.get("subtopic_names_done", []))
    pending = [s for s in subtopics if s["subtopic_id"] not in done_ids]

    if not pending:
        logger.info(f"Subtopic name embeddings: all {len(done_ids)} already done")
        return len(done_ids)

    total_done = len(done_ids)
    embed_model = config.get_embedding_model()
    if not embed_model:
        logger.error("No embedding model available")
        return total_done

    # Process in batches
    BATCH_SIZE = 50
    for i in range(0, len(pending), BATCH_SIZE):
        batch = pending[i : i + BATCH_SIZE]

        chunks = []
        for sub in batch:
            text = _make_subtopic_chunk_text(sub)
            try:
                embedding = embed_model.encode(text).tolist()
            except Exception as e:
                logger.warning(f"Embedding failed for {sub['subtopic_id']}: {e}")
                continue

            chunk_id = str(uuid.uuid5(
                uuid.NAMESPACE_DNS,
                f"subtopic_name:{sub['course']}:{sub['subtopic_id']}",
            ))
            chunks.append({
                "id": chunk_id,
                "embedding": embedding,
                "text_content": text,
                "metadata": {
                    "course": sub["course"],
                    "module_id": sub["module_id"],
                    "module_name": sub["module_name"],
                    "topic_id": sub["topic_id"],
                    "topic_name": sub["topic_name"],
                    "subtopic_id": sub["subtopic_id"],
                    "subtopic_name": sub["subtopic_name"],
                    "source": "subtopic_name",
                    "chunk_type": "subtopic_name",
                },
            })

        if chunks:
            try:
                added = vds.add_processed_chunks(chunks)
                logger.info(
                    f"Subtopic names: upserted {added}/{len(batch)} chunks "
                    f"[{total_done + i + 1}-{total_done + i + len(batch)}/{len(pending)}]"
                )
            except Exception as e:
                logger.error(f"Qdrant upsert failed for batch: {e}")

        # Update progress
        for sub in batch:
            done_ids.add(sub["subtopic_id"])
        progress["subtopic_names_done"] = list(done_ids)
        _save_progress(course, progress)

    logger.info(
        f"Subtopic names: completed {len(done_ids)}/{len(subtopics)} for '{course}'"
    )
    return len(done_ids)


def populate_stn_notes(course: str, progress: dict, subtopics: list, module_filter: str = None) -> int:
    """Generate STN notes and push to Qdrant stn_notes collection.
    Only processes a limited set (first module by default) since this requires LLM calls."""
    done_ids = set(progress.get("stn_notes_done", []))
    import subtopic_notes_generator as stn_gen

    # Filter by module if specified
    pending = [s for s in subtopics if s["subtopic_id"] not in done_ids]
    if module_filter:
        pending = [s for s in pending if s["module_id"] == module_filter]

    if not pending:
        logger.info(f"STN: all {len(done_ids)} already done")
        return len(done_ids)

    total_done = len(done_ids)
    logger.info(f"STN: Generating for {len(pending)} subtopics for '{course}'...")

    for idx, sub in enumerate(pending):
        sub_id = sub["subtopic_id"]
        sub_name = sub["subtopic_name"]
        topic_id = sub["topic_id"]
        topic_name = sub["topic_name"]

        logger.info(f"STN [{idx + 1}/{len(pending)}]: {course}/{sub_id}")
        try:
            result = stn_gen.generate_subtopic_notes(
                course=course,
                topic_id=topic_id,
                topic_name=topic_name,
                subtopic_id=sub_id,
                subtopic_name=sub_name,
                force=False,
            )
            if result:
                done_ids.add(sub_id)
                total_done += 1
                progress["stn_notes_done"] = list(done_ids)
                _save_progress(course, progress)
                logger.info(f"  STN generated ✓")
            else:
                logger.warning(f"  STN returned None for {sub_id}")
        except Exception as e:
            logger.error(f"  STN error for {sub_id}: {e}")

        time.sleep(1)  # rate limit for Ollama

    logger.info(f"STN: completed {total_done}/{len(subtopics)} for '{course}'")
    return total_done


def main():
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        sys.exit(1)

    all_courses = "--all" in args
    force = "--force" in args
    module_filter = None

    # Extract --module argument
    for i, arg in enumerate(args):
        if arg == "--module" and i + 1 < len(args):
            module_filter = args[i + 1]

    courses = []
    if all_courses:
        try:
            from curriculum_graph_handler import list_courses
            courses = list_courses()
            logger.info(f"Will process all {len(courses)} courses: {courses}")
        except Exception as e:
            logger.error(f"Failed to list courses: {e}")
            sys.exit(1)
    else:
        for arg in args:
            if not arg.startswith("--"):
                courses.append(arg)

    if not courses:
        logger.error("No courses specified")
        sys.exit(1)

    embed_model = config.get_embedding_model()
    if not embed_model:
        logger.error("Cannot get embedding model. Ensure RAG service is configured.")
        sys.exit(1)
    logger.info(f"Embedding model ready: {type(embed_model).__name__}")

    vds = VectorDBService()
    logger.info(f"VectorDBService initialized (collection: {vds.collection_name})")

    for course in courses:
        logger.info(f"\n=== Populating Qdrant for '{course}' ===")
        progress = {} if force else _load_progress(course)

        subtopics = _get_subtopics(course)
        if not subtopics:
            logger.warning(f"No subtopics found for '{course}', skipping")
            continue

        # Phase 1: Subtopic name embeddings to main collection
        logger.info(f"Phase 1: Subtopic name embeddings → main collection")
        populate_subtopic_names(course, vds, progress, subtopics)

        # Phase 2: STN notes to stn_notes collection
        logger.info(f"Phase 2: STN teaching notes → stn_notes collection")
        populate_stn_notes(course, progress, subtopics, module_filter)

        logger.info(f"=== Done populating Qdrant for '{course}' ===\n")


if __name__ == "__main__":
    main()
