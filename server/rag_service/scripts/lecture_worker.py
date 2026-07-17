"""
Background lecture generation worker.
Iterates all subtopics across all courses and generates missing lectures.
Progress is saved so the worker survives restarts.
"""
import sys, os, json, time, urllib.request, urllib.parse
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

RAG_URL = "http://127.0.0.1:2001"
PROGRESS_FILE = os.path.join(os.path.dirname(__file__), "..", "lecture_worker_progress.json")
BATCH_SIZE = 3  # generate N in parallel per batch
DELAY_BETWEEN = 2  # seconds between batches

def fetch_json(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())

def get_course_list():
    """Get all courses."""
    data = fetch_json(f"{RAG_URL}/curriculum/courses")
    return [c.get("course") if isinstance(c, dict) else c for c in data.get("courses", [])]

def get_subtopics(course):
    """Get all subtopics with their IDs, names, and topic names."""
    data = fetch_json(f"{RAG_URL}/curriculum/{urllib.parse.quote(course)}/structure", timeout=30)
    cur = data.get("curriculum", {})
    subs = []
    for m in cur.get("modules", []):
        for t in m.get("topics", []):
            for s in t.get("subtopics", []):
                subs.append({
                    "id": s.get("id", ""),
                    "name": s.get("name", ""),
                    "topic_name": t.get("name", ""),
                })
    return subs

def lecture_exists(course, subtopic_id):
    """Check if a lecture is already cached."""
    url = f"{RAG_URL}/curriculum/{urllib.parse.quote(course)}/lecture/{urllib.parse.quote(subtopic_id)}"
    url += "?subtopic_name=check&topic_name=check"
    try:
        req = urllib.request.Request(url)
        req.timeout = 5
        with urllib.request.urlopen(req) as r:
            d = json.loads(r.read())
            md = d.get("markdown", "")
            return not md.startswith(">") and len(md) > 200
    except:
        return False

def trigger_generation(course, subtopic):
    """Call the lecture endpoint to trigger generation (will cache on success)."""
    sid = subtopic["id"]
    sname = urllib.parse.quote(subtopic["name"])
    tname = urllib.parse.quote(subtopic["topic_name"])
    url = f"{RAG_URL}/curriculum/{urllib.parse.quote(course)}/lecture/{urllib.parse.quote(sid)}?subtopic_name={sname}&topic_name={tname}"
    try:
        req = urllib.request.Request(url)
        req.timeout = 300  # 5 minutes max for generation
        start = time.time()
        with urllib.request.urlopen(req) as r:
            d = json.loads(r.read())
            md = d.get("markdown", "")
            elapsed = time.time() - start
            success = not md.startswith(">") and len(md) > 200
            return success, elapsed
    except Exception as e:
        return False, str(e)

def main():
    print("=" * 60)
    print("LECTURE GENERATION WORKER")
    print("=" * 60)

    # Load progress
    progress = {"generated": 0, "skipped": 0, "failed": 0, "completed_courses": []}
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            progress.update(json.load(f))
        print(f"Resuming from previous run: {progress['generated']} generated, "
              f"{progress['failed']} failed, "
              f"{len(progress['completed_courses'])} courses done")

    start_time = time.time()

    courses = get_course_list()
    # Filter out already completed courses
    remaining = [c for c in courses if c not in progress["completed_courses"]]
    print(f"Total courses: {len(courses)}, remaining: {len(remaining)}")
    print()

    for ci, course in enumerate(remaining):
        course_start = time.time()
        print(f"[{ci+1}/{len(remaining)}] Course: {course}")

        subs = get_subtopics(course)
        print(f"  Subtopics: {len(subs)}")

        # Check which subtopics need generation
        pending = []
        for sub in subs:
            if not sub["id"]:
                continue
            if lecture_exists(course, sub["id"]):
                progress["skipped"] += 1
            else:
                pending.append(sub)

        print(f"  Already cached: {len(subs) - len(pending)}")
        print(f"  Need generation: {len(pending)}")

        # Generate in batches
        for bi in range(0, len(pending), BATCH_SIZE):
            batch = pending[bi:bi + BATCH_SIZE]
            for sub in batch:
                print(f"    Generating {course}/{sub['id'][:40]:40s}...", end=" ", flush=True)
                success, elapsed = trigger_generation(course, sub)
                if success:
                    progress["generated"] += 1
                    print(f"✅ {elapsed:.0f}s")
                else:
                    progress["failed"] += 1
                    print(f"❌ ({elapsed})")
                time.sleep(DELAY_BETWEEN)

        # Save checkpoint
        progress["completed_courses"].append(course)
        with open(PROGRESS_FILE, "w") as f:
            json.dump(progress, f, indent=2)

        course_elapsed = time.time() - course_start
        total_elapsed = time.time() - start_time
        remaining_subs = len(subs) - len(pending)
        print(f"  Course done in {course_elapsed:.0f}s. "
              f"Total: {progress['generated']} generated, "
              f"{progress['failed']} failed, "
              f"{progress['skipped']} skipped")
        print()

    total_elapsed = time.time() - start_time
    print("=" * 60)
    print("WORKER COMPLETE")
    print(f"Generated: {progress['generated']}")
    print(f"Skipped: {progress['skipped']}")
    print(f"Failed: {progress['failed']}")
    print(f"Time: {total_elapsed:.0f}s ({total_elapsed/60:.1f}m)")
    print(f"Progress saved to {PROGRESS_FILE}")

if __name__ == "__main__":
    main()
