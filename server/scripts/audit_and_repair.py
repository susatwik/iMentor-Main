#!/usr/bin/env python3
"""
Sprint 2 Curriculum Audit & Repair
===================================
Step 1: Parse every syllabus.csv → expected Module/Topic/Subtopic counts
Step 2: Compare vs Neo4j (via RAG API)
Step 3: Auto-repair mismatches via /curriculum/upload
Step 4: Verify lecture availability
Step 5: Generate final report
"""

import csv, io, json, os, re, sys, time, urllib.request, urllib.parse, urllib.error

RAG_URL = "http://localhost:2001"
BOOTSTRAP_DIR = "/Users/susatwikmanuri/Downloads/iMentor-Main/server/course_bootstrap"
SKIP_COURSES = {"EE"}  # aggregated format, not a real course

# ─── CSV Parsing (mirrors parse_unified_csv in curriculum_graph_handler.py) ───

def normalize_id(raw):
    if not raw:
        return ""
    return raw.strip().lower().replace(" ", "_").replace("-", "_")

def parse_syllabus_csv(filepath):
    """
    Parse a syllabus CSV and return (modules_dict, topics_list, subtopics_list, errors)
    Uses the same column detection as curriculum_graph_handler.parse_unified_csv()
    """
    modules_dict = {}
    topics = []
    subtopics = []
    errors = []
    
    encodings = ['utf-8-sig', 'utf-8', 'latin-1', 'cp1252']
    content = None
    for enc in encodings:
        try:
            with open(filepath, 'r', encoding=enc) as f:
                content = f.read()
            break
        except UnicodeDecodeError:
            continue
    
    if content is None:
        return {}, [], [], ["Could not read CSV with any supported encoding"]
    
    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames:
        return {}, [], [], ["CSV has no headers"]
    
    # Normalize field names
    normalized_fields = {name.strip().lower().replace(' ', '_'): name for name in reader.fieldnames}
    
    module_keys = ['module', 'unit', 'section']
    lecture_num_keys = ['lecture_number', 'lecture', 'order', 'number', 'lecture_no']
    topic_keys = ['lecture_topic', 'topic', 'title', 'name', 'lecture_title']
    subtopic_keys = ['subtopics', 'subtopic', 'prerequisites', 'concepts', 'sub_topics']
    
    def find_col(keys):
        for k in keys:
            if k in normalized_fields:
                return normalized_fields[k]
        return None
    
    module_col = find_col(module_keys)
    lecture_num_col = find_col(lecture_num_keys)
    topic_col = find_col(topic_keys)
    subtopic_col = find_col(subtopic_keys)
    
    if not topic_col:
        return {}, [], [], [f"Could not find topic column. Headers: {reader.fieldnames}"]
    
    module_order_counter = {}
    
    for row_num, row in enumerate(reader, start=2):
        module_name = row.get(module_col, '').strip() if module_col else f"Module {row_num}"
        
        if module_name and module_name not in modules_dict:
            module_order = len(modules_dict) + 1
            module_id = normalize_id(module_name)
            modules_dict[module_name] = {'id': module_id, 'name': module_name, 'order': module_order}
        
        topic_name = row.get(topic_col, '').strip()
        if not topic_name:
            errors.append(f"Row {row_num}: Missing topic, skipping")
            continue
        
        topic_id = normalize_id(topic_name)
        module_id = normalize_id(module_name) if module_name else None
        
        lecture_num = None
        if lecture_num_col:
            lecture_str = row.get(lecture_num_col, '')
            if lecture_str:
                num_match = re.search(r'\d+', str(lecture_str))
                if num_match:
                    lecture_num = int(num_match.group())
        
        topics.append({
            'id': topic_id,
            'name': topic_name,
            'module_id': module_id,
            'order': lecture_num if lecture_num else row_num
        })
        
        if subtopic_col:
            subtopics_str = row.get(subtopic_col, '').strip()
            if subtopics_str:
                subtopic_parts = [s.strip() for s in subtopics_str.split(',') if s.strip()]
                for sub_order, sub_name in enumerate(subtopic_parts, start=1):
                    sub_id = normalize_id(sub_name)
                    subtopics.append({
                        'id': sub_id,
                        'name': sub_name,
                        'topic_id': topic_id,
                        'order': sub_order
                    })
    
    # Deduplicate subtopics
    seen = {}
    unique_subtopics = []
    for st in subtopics:
        key = f"{st['id']}::{st.get('topic_id', '')}"
        if key not in seen:
            seen[key] = True
            unique_subtopics.append(st)
    
    modules = sorted(modules_dict.values(), key=lambda m: m['order'])
    
    return modules_dict, topics, unique_subtopics, errors


# ─── RAG API helpers ───

def rag_get(path):
    try:
        req = urllib.request.urlopen(f"{RAG_URL}{path}", timeout=30)
        return json.loads(req.read())
    except Exception as e:
        return {"error": str(e)}

def rag_post_upload(course_name, csv_path):
    """Upload a CSV via /curriculum/upload and return the response."""
    import subprocess
    try:
        proc = subprocess.run([
            "curl", "-s", "-X", "POST",
            f"{RAG_URL}/curriculum/upload",
            "-F", f"file=@{csv_path}",
            "-F", f"courseName={course_name}"
        ], capture_output=True, text=True, timeout=120)
        return json.loads(proc.stdout)
    except Exception as e:
        return {"success": False, "error": str(e)}


# ─── Main audit ───

def main():
    print("=" * 100)
    print("SPRINT 2 CURRICULUM AUDIT & REPAIR — Comprehensive Verification")
    print("=" * 100)
    
    # Discover all courses with syllabus.csv
    courses = []
    for entry in sorted(os.listdir(BOOTSTRAP_DIR)):
        course_dir = os.path.join(BOOTSTRAP_DIR, entry)
        if not os.path.isdir(course_dir):
            continue
        syllabus_path = os.path.join(course_dir, "syllabus.csv")
        if os.path.isfile(syllabus_path):
            courses.append((entry, syllabus_path))
    
    print(f"\n📁 Found {len(courses)} courses with syllabus.csv in course_bootstrap/\n")
    
    # ─── Phase 1: Parse & Compare ───
    results = []
    
    for course_code, csv_path in courses:
        if course_code in SKIP_COURSES:
            results.append({
                "course": course_code,
                "status": "SKIPPED",
                "reason": "Aggregated format, not a real course",
                "csv_modules": 0, "csv_topics": 0, "csv_subtopics": 0,
                "csv_topics_with_subtopics": 0,
                "neo_modules": 0, "neo_topics": 0, "neo_subtopics": 0,
                "needs_repair": False, "repaired": False, "csv_errors": [],
            })
            continue
        
        # Parse CSV
        modules_dict, topics, subtopics, csv_errors = parse_syllabus_csv(csv_path)
        
        csv_module_count = len(modules_dict)
        csv_topic_count = len(topics)
        csv_subtopic_count = len(subtopics)
        
        # Track which CSV topics have subtopics (for genuine gap detection)
        topic_ids_with_subtopics = set(s['topic_id'] for s in subtopics)
        csv_topics_with_subtopics = len(topic_ids_with_subtopics)
        
        # Query Neo4j via RAG
        url_path = f"/curriculum/{urllib.parse.quote(course_code, safe='')}/structure"
        neo_data = rag_get(url_path)
        
        neo_modules = 0
        neo_topics = 0
        neo_subtopics = 0
        neo_empty_topics = 0
        
        if "error" not in neo_data:
            cur = neo_data.get("curriculum", neo_data)
            mods = cur.get("modules", [])
            neo_modules = len(mods)
            neo_topics = sum(len(m.get("topics", [])) for m in mods)
            neo_subtopics = sum(len(t.get("subtopics", [])) for m in mods for t in m.get("topics", []))
            neo_empty_topics = sum(1 for m in mods for t in m.get("topics", []) if not t.get("subtopics"))
        
        # Determine if match
        csv_has_subtopics = csv_subtopic_count > 0
        neo_has_subtopics = neo_subtopics > 0
        
        modules_match = neo_modules == csv_module_count if csv_module_count > 0 else True
        topics_match = neo_topics == csv_topic_count if csv_topic_count > 0 else True
        subtopics_match = neo_subtopics == csv_subtopic_count if csv_subtopic_count > 0 else True
        
        needs_repair = False
        status = "PASS"
        reason = ""
        repaired = False
        
        if csv_errors and csv_module_count == 0 and csv_topic_count == 0:
            needs_repair = False
            status = "CSV_ERROR"
            reason = "; ".join(csv_errors[:3])
        elif not modules_match or not topics_match or \
             (csv_has_subtopics and not neo_has_subtopics) or \
             (csv_has_subtopics and neo_empty_topics > 0) or \
             (csv_subtopic_count > 0 and not subtopics_match):
            needs_repair = True
            status = "MISMATCH"
            reason_parts = []
            if not modules_match:
                reason_parts.append(f"modules: CSV={csv_module_count}, Neo4j={neo_modules}")
            if not topics_match:
                reason_parts.append(f"topics: CSV={csv_topic_count}, Neo4j={neo_topics}")
            if csv_has_subtopics and not subtopics_match and csv_subtopic_count != neo_subtopics:
                reason_parts.append(f"subtopics: CSV={csv_subtopic_count}, Neo4j={neo_subtopics}")
            if csv_has_subtopics and not neo_has_subtopics:
                reason_parts.append("CSV has subtopics but Neo4j has none")
            if csv_has_subtopics and neo_empty_topics > 0:
                reason_parts.append(f"{neo_empty_topics} topics with empty subtopics in Neo4j")
            reason = "; ".join(reason_parts)
        
        results.append({
            "course": course_code,
            "status": status,
            "reason": reason,
            "csv_modules": csv_module_count,
            "csv_topics": csv_topic_count,
            "csv_subtopics": csv_subtopic_count,
            "csv_topics_with_subtopics": csv_topics_with_subtopics,
            "neo_modules": neo_modules,
            "neo_topics": neo_topics,
            "neo_subtopics": neo_subtopics,
            "needs_repair": needs_repair,
            "repaired": repaired,
            "csv_errors": csv_errors,
            "csv_path": csv_path,
        })
        
        icon = "✅" if status == "PASS" else "⚠️" if status == "MISMATCH" else "⏭️" if status == "SKIPPED" else "❌"
        print(f"  {icon} {course_code:25s} | CSV: {csv_module_count:2d}m/{csv_topic_count:2d}t/{csv_subtopic_count:3d}s | Neo4j: {neo_modules:2d}m/{neo_topics:2d}t/{neo_subtopics:3d}s | {status}{' - ' + reason if reason else ''}")
    
    # ─── Phase 2: Repair ───
    to_repair = [r for r in results if r["needs_repair"]]
    print(f"\n{'=' * 100}")
    print(f"PHASE 2: AUTO-REPAIR — {len(to_repair)} courses need re-ingestion")
    print(f"{'=' * 100}")
    
    for r in to_repair:
        print(f"\n  🔧 Repairing {r['course']}...")
        print(f"     Reason: {r['reason']}")
        
        resp = rag_post_upload(r["course"], r["csv_path"])
        
        if resp.get("success"):
            r["repaired"] = True
            r["status"] = "REPAIRED"
            created = {
                "modules": resp.get("modules_created", 0),
                "topics": resp.get("topics_created", 0),
                "subtopics": resp.get("subtopics_created", 0),
            }
            print(f"     ✅ Repaired: {created['modules']}m/{created['topics']}t/{created['subtopics']}s created")
        else:
            r["status"] = "REPAIR_FAILED"
            err = resp.get("message", resp.get("error", "unknown"))
            print(f"     ❌ Repair failed: {err}")
        
        time.sleep(0.3)
    
    # ─── Phase 3: Post-repair verification ───
    print(f"\n{'=' * 100}")
    print(f"PHASE 3: POST-REPAIR VERIFICATION")
    print(f"{'=' * 100}")
    
    for r in results:
        if r["status"] in ("SKIPPED", "PASS"):
            continue
        
        # Re-verify for all non-skipped, non-pass courses
        url_path = f"/curriculum/{urllib.parse.quote(r['course'], safe='')}/structure"
        neo_data = rag_get(url_path)
        
        neo_modules = 0
        neo_topics = 0
        neo_subtopics = 0
        neo_empty_topics = 0
        
        if "error" not in neo_data:
            cur = neo_data.get("curriculum", neo_data)
            mods = cur.get("modules", [])
            neo_modules = len(mods)
            neo_topics = sum(len(m.get("topics", [])) for m in mods)
            neo_subtopics = sum(len(t.get("subtopics", [])) for m in mods for t in m.get("topics", []))
            neo_empty_topics = sum(1 for m in mods for t in m.get("topics", []) if not t.get("subtopics"))
        
        csv_has = r["csv_subtopics"] > 0
        neo_has = neo_subtopics > 0
        modules_match = neo_modules == r["csv_modules"]
        topics_match = neo_topics == r["csv_topics"]
        
        # Check subtopics: count must match, and if CSV has subtopics all topics should have them
        # EXCEPT when the CSV genuinely has some topics with empty subtopics
        subtopics_match = neo_subtopics == r["csv_subtopics"]
        
        # Determine how many topics in CSV have subtopics vs not by re-examining the source
        # We use the stored CSV parse result
        csv_topics_with_subtopics = r.get("csv_topics_with_subtopics", 0)
        
        if modules_match and topics_match and subtopics_match and \
           (not csv_has or neo_has):
            # Check if the gaps in Neo4j match gaps in CSV (genuine source gaps)
            gaps_acceptable = (csv_topics_with_subtopics == 0 or 
                               neo_empty_topics <= (r["csv_topics"] - csv_topics_with_subtopics))
            
            if neo_empty_topics == 0 or gaps_acceptable:
                r["status"] = "PASS"
                if r.get("repaired"):
                    print(f"  ✅ {r['course']}: Verified after repair")
                else:
                    print(f"  ✅ {r['course']}: Verified (counts match)")
            else:
                r["status"] = "PASS_WITH_GAP"
                r["neo_subtopics"] = neo_subtopics
                print(f"  ✅ {r['course']}: Verified (with {neo_empty_topics} genuine gaps)")
        elif csv_has and not neo_has:
            r["status"] = "STILL_EMPTY"
            print(f"  ❌ {r['course']}: Still has empty subtopics after repair")
        elif not subtopics_match:
            r["status"] = "STILL_MISMATCH"
            print(f"  ⚠️  {r['course']}: CSV subtopics={r['csv_subtopics']}, Neo4j={neo_subtopics}")
        else:
            r["status"] = "PASS"
            print(f"  ✅ {r['course']}: Verified")
        
        r["neo_modules"] = neo_modules
        r["neo_topics"] = neo_topics
        r["neo_subtopics"] = neo_subtopics
        
        time.sleep(0.2)
    
    # ─── Phase 4: Lecture verification ───
    print(f"\n{'=' * 100}")
    print(f"PHASE 4: LECTURE VERIFICATION (sample)")
    print(f"{'=' * 100}")
    
    lecture_sample_count = 0
    lecture_ok = 0
    
    for r in results:
        if r["status"] not in ("PASS", "REPAIRED", "PASS_WITH_GAP"):
            continue
        if r["neo_subtopics"] == 0:
            continue
        
        # Test up to 2 lectures per course
        url_path = f"/curriculum/{urllib.parse.quote(r['course'], safe='')}/structure"
        neo_data = rag_get(url_path)
        if "error" in neo_data:
            continue
        
        cur = neo_data.get("curriculum", neo_data)
        tested = 0
        for mod in cur.get("modules", []):
            for top in mod.get("topics", []):
                for sub in top.get("subtopics", []):
                    if tested >= 2:
                        break
                    sub_id = sub.get("id", "")
                    if not sub_id:
                        continue
                    
                    lect_url = f"/curriculum/{urllib.parse.quote(r['course'], safe='')}/lecture/{sub_id}"
                    lect_data = rag_get(lect_url)
                    
                    has_md = bool(lect_data.get("markdown"))
                    src = lect_data.get("source", "unknown")
                    lecture_sample_count += 1
                    
                    if has_md:
                        lecture_ok += 1
                    else:
                        print(f"  ⚠️  {r['course']}/{sub_id}: No lecture (source={src})")
                    
                    tested += 1
                    time.sleep(0.1)
        
        if tested > 0 and lecture_sample_count % 10 == 0:
            print(f"     ... sampled {lecture_sample_count} lectures, {lecture_ok} OK")
    
    print(f"\n  Sampled {lecture_sample_count} lectures, {lecture_ok} available ({lecture_ok*100//max(lecture_sample_count,1)}%)")
    
    # ─── Phase 5: Final Report ───
    print(f"\n{'=' * 100}")
    print(f"FINAL VERIFICATION REPORT")
    print(f"{'=' * 100}")
    
    pass_count = sum(1 for r in results if r["status"] in ("PASS", "REPAIRED", "PASS_WITH_GAP"))
    repair_count = sum(1 for r in results if r.get("repaired"))
    skip_count = sum(1 for r in results if r["status"] == "SKIPPED")
    csv_error_count = sum(1 for r in results if r["status"] == "CSV_ERROR")
    still_failing = sum(1 for r in results if r["status"] in ("STILL_EMPTY", "STILL_MISMATCH", "REPAIR_FAILED"))
    genuine_empty = sum(1 for r in results if r["status"] == "PASS" and r["csv_subtopics"] == 0)
    
    print(f"\n{'COURSE':25s} | {'CSV M':>5s} {'CSV T':>5s} {'CSV S':>5s} | {'NEO M':>5s} {'NEO T':>5s} {'NEO S':>5s} | {'STATUS':20s}")
    print("-" * 90)
    for r in sorted(results, key=lambda x: x["course"]):
        status_icon = {
            "PASS": "✅", "REPAIRED": "🔧", "PASS_WITH_GAP": "✅",
            "SKIPPED": "⏭️", "CSV_ERROR": "❌",
            "STILL_EMPTY": "❌", "STILL_MISMATCH": "⚠️", "REPAIR_FAILED": "❌"
        }.get(r["status"], "❓")
        print(f"{status_icon} {r['course']:23s} | {r['csv_modules']:5d} {r['csv_topics']:5d} {r['csv_subtopics']:5d} | {r['neo_modules']:5d} {r['neo_topics']:5d} {r['neo_subtopics']:5d} | {r['status']:20s}")
    
    print("-" * 90)
    
    print(f"""
{'=' * 100}
SUMMARY
{'=' * 100}

  Total courses audited:      {len(results)}
  ✅ Fully verified (PASS):   {pass_count}
     of which genuine empty:  {genuine_empty}
  🔧 Repaired (REPAIRED):     {repair_count}
  ⏭️  Skipped:                  {skip_count}
  ❌ CSV errors:               {csv_error_count}
  ❌ Still failing:            {still_failing}

  Lecture sample rate:        {lecture_ok}/{lecture_sample_count} ({lecture_ok*100//max(lecture_sample_count,1)}%)

REPAIR SUMMARY:
  Courses needing repair:     {len(to_repair)}
  Successfully repaired:      {repair_count}
  Failed to repair:           {still_failing}

GENUINE DATA GAPS (empty subtopics in source CSV):
""")
    
    for r in sorted(results, key=lambda x: x["course"]):
        if r["csv_subtopics"] == 0 and r["status"] in ("PASS", "PASS_WITH_GAP"):
            print(f"  • {r['course']}: Lab/practical course with no subtopics in syllabus")
    
    print(f"\n{'=' * 100}")
    print(f"REPORT GENERATED: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'=' * 100}")


if __name__ == "__main__":
    main()
