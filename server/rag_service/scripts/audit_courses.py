"""
Comprehensive curriculum audit script.
Connects to Neo4j and RAG API to check every course's hierarchy depth.
"""
import httpx
import asyncio
import json
import os
import sys
from datetime import datetime

RAG_URL = os.environ.get("RAG_URL", "http://127.0.0.1:2001")
AUDIT_FILE = os.path.join(os.path.dirname(__file__), "..", "course_audit.json")

async def fetch_json(url, timeout=30):
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.json()

async def count_neo4j_direct(neo4j_driver, course):
    """Count nodes per course directly from Neo4j for accurate diagnosis."""
    counts = {}
    with neo4j_driver.session() as session:
        for label in ["Module", "Topic", "Subtopic"]:
            result = session.run(
                f"MATCH (n:{label} {{course: $course}}) RETURN count(n) as cnt",
                course=course
            )
            counts[label.lower()] = result.single()["cnt"]
        # Check for Course node
        result = session.run(
            "MATCH (c:Course {course: $course}) RETURN count(c) as cnt",
            course=course
        )
        counts["course_node"] = result.single()["cnt"]
        # Check relationships
        result = session.run(
            "MATCH (m:Module {course: $course})-[:HAS_TOPIC]->(t:Topic) RETURN count(t) as cnt",
            course=course
        )
        counts["has_topic_rels"] = result.single()["cnt"]
        result = session.run(
            "MATCH (t:Topic {course: $course})<-[p:PREREQUISITE_OF]-(s:Subtopic) RETURN count(s) as cnt",
            course=course
        )
        counts["has_subtopic_rels"] = result.single()["cnt"]
        # Check REFERENCES_TOPIC
        result = session.run(
            "MATCH (c:Course {course: $course})-[r:REFERENCES_TOPIC]->(t:Topic) RETURN count(r) as cnt",
            course=course
        )
        counts["references_topic_rels"] = result.single()["cnt"]
    return counts

async def check_lecture_cache(course, subtopic_ids):
    """Check how many subtopics have cached lecture files."""
    cache_dir = os.path.join(
        os.path.dirname(__file__), "..", "course_bootstrap",
        course, "lecture_notes", "subtopics"
    )
    if not os.path.isdir(cache_dir):
        return {"lecture_dir_exists": False, "cached_lectures": 0, "total_subtopics": len(subtopic_ids)}
    cached = sum(1 for sid in subtopic_ids if os.path.isfile(os.path.join(cache_dir, f"{sid}.md")))
    return {
        "lecture_dir_exists": True,
        "cached_lectures": cached,
        "total_subtopics": len(subtopic_ids),
        "cache_path": cache_dir
    }

async def check_lecture_md(course):
    """Check if lecture.md exists."""
    base = os.path.join(os.path.dirname(__file__), "..", "course_bootstrap", course, "lecture_notes")
    if not os.path.isdir(base):
        return {"lecture_md_exists": False}
    import glob
    files = glob.glob(os.path.join(base, "**", "lecture.md"), recursive=True)
    return {"lecture_md_exists": len(files) > 0, "lecture_md_files": files}

async def audit_course(course_name, neo4j_driver=None):
    """Audit a single course."""
    result = {
        "course": course_name,
        "api_structure": None,
        "neo4j_counts": None,
        "lecture_info": None,
        "status": "UNKNOWN",
        "errors": []
    }
    # 1. Check API structure
    try:
        data = await fetch_json(f"{RAG_URL}/curriculum/{course_name}/structure")
        result["api_structure"] = data
        if data.get("success") and data.get("curriculum"):
            c = data["curriculum"]
            modules = c.get("modules", [])
            topic_count = sum(len(m.get("topics", [])) for m in modules)
            subtopic_count = sum(
                sum(len(t.get("subtopics", [])) for t in m.get("topics", []))
                for m in modules
            )
            result["api_counts"] = {
                "modules": len(modules),
                "topics": topic_count,
                "subtopics": subtopic_count
            }
            # Collect all subtopic IDs for lecture check
            all_subtopic_ids = []
            for m in modules:
                for t in m.get("topics", []):
                    for s in t.get("subtopics", []):
                        all_subtopic_ids.append(s.get("id", ""))
            result["subtopic_ids"] = all_subtopic_ids
        else:
            result["api_counts"] = {"modules": 0, "topics": 0, "subtopics": 0}
            result["subtopic_ids"] = []
    except Exception as e:
        result["errors"].append(f"API structure error: {e}")
        result["api_counts"] = {"modules": 0, "topics": 0, "subtopics": 0}
        result["subtopic_ids"] = []

    # 2. Neo4j direct counts
    if neo4j_driver:
        try:
            result["neo4j_counts"] = await count_neo4j_direct(neo4j_driver, course_name)
        except Exception as e:
            result["errors"].append(f"Neo4j error: {e}")

    # 3. Lecture info
    try:
        lecture_info = await check_lecture_cache(
            course_name, result.get("subtopic_ids", [])
        )
        lecture_md_info = await check_lecture_md(course_name)
        lecture_info.update(lecture_md_info)
        result["lecture_info"] = lecture_info
    except Exception as e:
        result["errors"].append(f"Lecture check error: {e}")

    # 4. Determine status
    ac = result["api_counts"]
    if ac["modules"] > 0 and ac["topics"] > 0 and ac["subtopics"] > 0:
        li = result.get("lecture_info", {})
        cached = li.get("cached_lectures", 0) if li else 0
        if cached == ac["subtopics"]:
            result["status"] = "COMPLETE"
        elif cached > 0:
            result["status"] = "PARTIAL_LECTURES"
        else:
            result["status"] = "NO_LECTURES"
    elif ac["modules"] > 0 and ac["topics"] > 0 and ac["subtopics"] == 0:
        result["status"] = "NO_SUBTOPICS"
    elif ac["modules"] > 0 and ac["topics"] == 0:
        result["status"] = "NO_TOPICS"
    elif ac["modules"] == 0:
        result["status"] = "EMPTY"
    else:
        result["status"] = "PARTIAL"

    return result

async def main():
    # Try to connect to Neo4j for accurate diagnosis
    neo4j_driver = None
    try:
        from neo4j import GraphDatabase
        NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7688")
        NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
        NEO4J_PASS = os.environ.get("NEO4J_PASS", "imentor123")
        neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))
        neo4j_driver.verify_connectivity()
        print(f"Connected to Neo4j at {NEO4J_URI}")
    except Exception as e:
        print(f"Neo4j connection failed (using API only): {e}")
        neo4j_driver = None

    # Get all courses from API
    print("Fetching course list...")
    try:
        data = await fetch_json(f"{RAG_URL}/curriculum/courses")
        courses = data.get("courses", [])
        print(f"Found {len(courses)} courses via API")
    except Exception as e:
        print(f"Failed to fetch courses: {e}")
        # Fallback: try Neo4j directly
        if neo4j_driver:
            with neo4j_driver.session() as session:
                result = session.run("MATCH (c:Course) RETURN c.course as course ORDER BY c.course")
                courses = [r["course"] for r in result]
            print(f"Fallback: Found {len(courses)} courses via Neo4j")
        else:
            print("Cannot fetch courses. Exiting.")
            sys.exit(1)

    # Audit each course
    all_results = []
    completed = 0
    partial = 0
    empty = 0
    errors = 0

    for i, course in enumerate(courses):
        course_name = course.get("course") if isinstance(course, dict) else course
        if not course_name:
            continue
        print(f"[{i+1}/{len(courses)}] Auditing {course_name}...", end=" ", flush=True)
        try:
            result = await audit_course(course_name, neo4j_driver)
            all_results.append(result)
            status = result["status"]
            if status == "COMPLETE":
                completed += 1
                print("✅ COMPLETE")
            elif status == "NO_LECTURES":
                partial += 1
                print("📄 NO_LECTURES")
            elif status == "PARTIAL_LECTURES":
                partial += 1
                print("📄 PARTIAL_LECTURES")
            elif status == "EMPTY":
                empty += 1
                print("❌ EMPTY")
            elif status == "NO_SUBTOPICS":
                partial += 1
                print("⚠️  NO_SUBTOPICS")
            elif status == "NO_TOPICS":
                partial += 1
                print("⚠️  NO_TOPICS")
            else:
                partial += 1
                print(f"⚠️  {status}")
        except Exception as e:
            errors += 1
            all_results.append({"course": course_name, "status": "ERROR", "error": str(e)})
            print(f"💥 ERROR: {e}")

    # Generate summary
    summary = {
        "timestamp": datetime.now().isoformat(),
        "total_courses": len(all_results),
        "complete": completed,
        "partial": partial,
        "empty": empty,
        "errors": errors,
        "courses": all_results
    }

    with open(AUDIT_FILE, "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"\nAudit saved to {AUDIT_FILE}")
    print(f"Total: {len(all_results)}, Complete: {completed}, Partial: {partial}, Empty: {empty}, Errors: {errors}")

    if neo4j_driver:
        neo4j_driver.close()

if __name__ == "__main__":
    asyncio.run(main())
