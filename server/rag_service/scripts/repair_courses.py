"""
Comprehensive curriculum repair pipeline.
Idempotent — only repairs missing pieces, never duplicates or overwrites.
"""
import sys, os, json, re, requests
from datetime import datetime
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from neo4j import GraphDatabase
import config

RAG_URL = os.environ.get("RAG_URL", "http://127.0.0.1:2001")
REPORT_FILE = os.path.join(os.path.dirname(__file__), "..", "repair_report.json")

# =========================================================================
# Neo4j helpers
# =========================================================================

def get_driver():
    return GraphDatabase.driver(
        config.NEO4J_URI,
        auth=(config.NEO4J_USERNAME, config.NEO4J_PASSWORD)
    )

def run_read(tx, query, params=None):
    return list(tx.run(query, params or {}))

def run_write(tx, query, params=None):
    return list(tx.run(query, params or {}))

# =========================================================================
# Lab course subtopic templates
# =========================================================================

LAB_SUBTOPIC_TEMPLATES = {
    "lab": [
        "Introduction and Safety Precautions",
        "Experiment 1: Familiarization of Equipment",
        "Experiment 2: Circuit Analysis and Measurements",
        "Experiment 3: Performance Characteristics",
        "Experiment 4: Troubleshooting and Diagnostics",
        "Experiment 5: Design and Simulation",
        "Experiment 6: Advanced Applications",
        "Experiment 7: Comprehensive Testing",
        "Experiment 8: Mini Project",
        "Viva Voce and Review"
    ],
    "analog and digital circuits lab": [
        "Diode Characteristics",
        "Transistor Biasing Circuits",
        "Operational Amplifier Applications",
        "Active Filters",
        "Logic Gate Characteristics",
        "Combinational Logic Circuits",
        "Sequential Logic Circuits",
        "Counters and Registers",
        "ADC/DAC Converters",
        "Circuit Simulation using SPICE"
    ],
    "circuits and measurements lab": [
        "Measurement of Resistance using Wheatstone Bridge",
        "Measurement of Inductance using Maxwell Bridge",
        "Measurement of Capacitance using Schering Bridge",
        "Calibration of Voltmeter and Ammeter",
        "Measurement of Power using Wattmeter",
        "Measurement of Energy using Energy Meter",
        "CRO Measurements: Frequency and Phase",
        "LVDT Characteristics",
        "Strain Gauge Measurement",
        "Temperature Measurement using Thermocouple"
    ],
    "control systems lab": [
        "Transfer Function of DC Servo Motor",
        "AC Servo Motor Characteristics",
        "Step Response of First Order Systems",
        "Step Response of Second Order Systems",
        "Frequency Response Analysis using Bode Plots",
        "Stability Analysis using Root Locus",
        "PID Controller Design and Tuning",
        "State Space Model Simulation",
        "Lead-Lag Compensator Design",
        "Digital Control System Implementation"
    ],
    "ac rotating machines lab": [
        "No-Load and Blocked Rotor Test on Induction Motor",
        "Load Test on Three-Phase Induction Motor",
        "No-Load and Short Circuit Test on Synchronous Generator",
        "V-Curves of Synchronous Motor",
        "Slip Test on Induction Motor",
        "Load Test on Single-Phase Induction Motor",
        "Speed Control of Induction Motor using VFD",
        "Parallel Operation of Alternators",
        "Power Factor Improvement using Synchronous Condenser",
        "Performance of Brushless DC Motor"
    ],
    "power systems & renewable energy lab": [
        "Load Flow Analysis using Newton-Raphson Method",
        "Fault Analysis: Symmetrical Faults",
        "Fault Analysis: Unsymmetrical Faults",
        "Economic Load Dispatch",
        "Unit Commitment Problem",
        "Transmission Line Parameter Estimation",
        "Solar PV Panel Characteristics",
        "Wind Turbine Power Curve",
        "Battery Energy Storage System",
        "Grid-Connected Inverter Operation"
    ],
    "power electronics lab": [
        "SCR Characteristics",
        "MOSFET and IGBT Characteristics",
        "Single-Phase Half-Controlled Rectifier",
        "Single-Phase Fully-Controlled Rectifier",
        "Three-Phase Rectifier",
        "DC-DC Buck Converter",
        "DC-DC Boost Converter",
        "Single-Phase Inverter",
        "Three-Phase Inverter",
        "PWM Techniques for Inverters"
    ],
    "embedded systems lab": [
        "Introduction to Microcontroller Programming",
        "GPIO Interfacing: LEDs and Switches",
        "Timer and Counter Programming",
        "PWM Generation",
        "ADC Interfacing",
        "UART Serial Communication",
        "I2C Sensor Interfacing",
        "SPI Display Interfacing",
        "Interrupt Programming",
        "Real-Time Clock and Power Management"
    ],
    "electric power drives lab": [
        "DC Motor Speed Control using Chopper",
        "Four-Quadrant DC Drive Operation",
        "AC Motor Speed Control using VSI",
        "V/f Control of Induction Motor",
        "Rotor Resistance Control of Wound Rotor Motor",
        "Regenerative Braking of DC Motor",
        "Field-Oriented Control of PMSM",
        "Stepper Motor Control",
        "BLDC Motor Drive",
        "Load Torque Measurement and Analysis"
    ],
    "data structures and applications lab": [
        "Array Operations and Sorting",
        "Linked List Implementation",
        "Stack and Queue Applications",
        "Binary Search Tree Operations",
        "Graph Traversal: BFS and DFS",
        "Hashing Techniques",
        "Heap Data Structure",
        "AVL Tree Rotations",
        "Priority Queue Applications",
        "Algorithm Complexity Analysis"
    ]
}

def get_subtopics_for_course(course_name, topic_name):
    """Generate meaningful subtopics for a course based on its name and type."""
    name_lower = (course_name + " " + topic_name).lower()
    
    # Try exact template match first
    for key, subs in LAB_SUBTOPIC_TEMPLATES.items():
        if key in name_lower:
            return subs[:]
    
    # Check if it's a lab course (course code ends in 2 or name contains "lab")
    is_lab = (
        re.search(r'\d2$', course_name) or 
        "lab" in name_lower or 
        "laboratory" in name_lower or
        "practical" in name_lower
    )
    
    if is_lab:
        # Generic lab subtopics
        num_expts = min(10, max(6, len(course_name) % 5 + 6))
        return [f"Experiment {i+1}" for i in range(num_expts)]
    
    # For non-lab EMPTY courses, create module-level topics
    return None  # Signal to use EE mega-course or auto-generate

def generate_auto_curriculum(course_code, course_name, semester, category):
    """Generate a minimal curriculum for a course that has no source data."""
    # Use course name words as subtopics
    words = re.sub(r'[^a-zA-Z\s]', '', course_name).split()
    # Filter out common words
    stopwords = {'the', 'a', 'an', 'of', 'for', 'and', 'in', 'to', 'with', 'using', 'based', 'via'}
    keywords = [w for w in words if w.lower() not in stopwords and len(w) > 2]
    
    if len(keywords) < 3:
        # Generate from course category
        if category in ('DEC', 'PEC'):
            subtopics = [
                f"Introduction to {course_name}",
                f"Fundamentals and Principles",
                f"Design and Analysis",
                f"Applications and Case Studies",
                f"Emerging Trends",
                f"Project Work"
            ]
        elif category == 'HSC':
            subtopics = [
                f"Introduction to {course_name}",
                "Key Concepts and Theories",
                "Practical Applications",
                "Case Studies",
                "Review and Assessment"
            ]
        elif category == 'PRC':
            subtopics = [
                "Project Planning and Scope",
                "Literature Review",
                "Design and Methodology",
                "Implementation",
                "Testing and Validation",
                "Results and Discussion",
                "Report Writing and Presentation"
            ]
        elif category == 'ESC':
            subtopics = [
                f"Introduction to {course_name}",
                "Core Concepts",
                "Analysis and Design",
                "Laboratory Applications",
                "Industry Relevance"
            ]
        else:
            subtopics = [
                f"Introduction to {course_name}",
                "Fundamental Concepts",
                "Advanced Topics",
                "Applications",
                "Review"
            ]
    else:
        subtopics = [f"Introduction to {w}" for w in keywords[:6]]
    
    return {
        "module": f"Module 1: {course_name}",
        "module_id": f"module1_{course_code.lower()}",
        "topic": course_name,
        "topic_id": course_code.lower() + "___" + re.sub(r'[^a-z0-9_]', '_', course_name.lower()).strip('_'),
        "subtopics": [
            {"name": s, "order": i+1, "id": course_code.lower() + "___" + re.sub(r'[^a-z0-9_]', '_', s.lower()).strip('_')}
            for i, s in enumerate(subtopics)
        ]
    }

# =========================================================================
# Repair operations
# =========================================================================

def repair_course(driver, course_code, audit_entry):
    """Repair a single course. Returns repair actions taken."""
    actions = []
    
    # 1. Check if course has Module/Topic/Subtopic nodes with its course code
    with driver.session(database=config.NEO4J_DATABASE) as session:
        mod_count = session.run(
            "MATCH (m:Module {course: $course}) RETURN count(m) as cnt",
            course=course_code
        ).single()["cnt"]
        
        topic_count = session.run(
            "MATCH (t:Topic {course: $course}) RETURN count(t) as cnt",
            course=course_code
        ).single()["cnt"]
        
        sub_count = session.run(
            "MATCH (s:Subtopic {course: $course}) RETURN count(s) as cnt",
            course=course_code
        ).single()["cnt"]
        
        # Check if Course node exists
        course_node = session.run(
            "MATCH (c:Course {course: $course}) RETURN c",
            course=course_code
        ).single()
    
    # If course already has full hierarchy, skip
    if mod_count > 0 and topic_count > 0 and sub_count > 0:
        return actions
    
    # 2. Try to find matching topic in mega-course (EE, CS, etc.)
    #    Topic IDs in mega-courses follow format: eecode___name
    #    e.g., ee1611___basics_of_electrical_engineering
    with driver.session(database=config.NEO4J_DATABASE) as session:
        # Find courses that are mega-courses (have modules with topics referencing individual courses)
        # Look for any Module with course != our course code that has a Topic.id starting with our code
        mega_topics = session.run("""
            MATCH (m:Module)-[:HAS_TOPIC]->(t:Topic)
            WHERE m.course <> $course AND toLower(t.id) STARTS WITH toLower($prefix)
            RETURN m.course AS mega_course, m.id AS module_id, m.name AS module_name,
                   t.id AS topic_id, t.name AS topic_name, t.order AS topic_order
            ORDER BY m.order, t.order
            LIMIT 1
        """, course=course_code, prefix=course_code.lower()).single()
    
    if mega_topics:
        print(f"    Found in mega-course '{mega_topics['mega_course']}': {mega_topics['topic_name']}")
        actions.append(f"found_in_mega_course:{mega_topics['mega_course']}")
        
        # Create Module/Topic/Subtopic nodes for this individual course
        with driver.session(database=config.NEO4J_DATABASE) as session:
            # Get the full topic with its subtopics from the mega-course
            mega_data = session.run("""
                MATCH (m:Module {course: $mega_course, id: $module_id})
                OPTIONAL MATCH (m)-[:HAS_TOPIC]->(t:Topic {id: $topic_id})
                OPTIONAL MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t)
                WHERE s.course = $mega_course
                RETURN m.id AS mid, m.name AS mname, m.order AS morder,
                       t.id AS tid, t.name AS tname, t.order AS torder,
                       collect(DISTINCT {id: s.id, name: s.name, order: s.order}) AS subtopics
            """, mega_course=mega_topics["mega_course"],
                 module_id=mega_topics["module_id"],
                 topic_id=mega_topics["topic_id"]).single()
            
            if mega_data["mid"]:
                # Create module for individual course
                mod_id = f"{course_code.lower()}_{mega_data['mid']}"
                session.run("""
                    MERGE (m:Module {course: $course, id: $mid})
                    SET m.name = $mname, m.order = $morder,
                        m.createdAt = datetime(), m.updatedAt = datetime()
                """, course=course_code, mid=mod_id,
                     mname=mega_data["mname"], morder=mega_data["morder"])
                
                if mega_data["tid"]:
                    topic_id = mega_data["tid"]
                    session.run("""
                        MERGE (t:Topic {course: $course, id: $tid})
                        SET t.name = $tname, t.order = $torder,
                            t.module_id = $mid,
                            t.createdAt = datetime(), t.updatedAt = datetime()
                    """, course=course_code, tid=topic_id,
                         tname=mega_data["tname"], torder=mega_data["torder"],
                         mid=mod_id)
                    
                    # Link Module -> Topic
                    session.run("""
                        MATCH (m:Module {course: $course, id: $mid})
                        MATCH (t:Topic {course: $course, id: $tid})
                        MERGE (m)-[:HAS_TOPIC]->(t)
                    """, course=course_code, mid=mod_id, tid=topic_id)
                    
                    # Create subtopics
                    sub_count_created = 0
                    for s in mega_data["subtopics"]:
                        if s["id"]:
                            session.run("""
                                MERGE (sub:Subtopic {course: $course, id: $sid})
                                SET sub.name = $sname, sub.order = $sorder,
                                    sub.topic_id = $tid,
                                    sub.createdAt = datetime(), sub.updatedAt = datetime()
                            """, course=course_code, sid=s["id"],
                                 sname=s["name"], sorder=s["order"], tid=topic_id)
                            
                            session.run("""
                                MATCH (sub:Subtopic {course: $course, id: $sid})
                                MATCH (t:Topic {course: $course, id: $tid})
                                MERGE (sub)-[:PREREQUISITE_OF]->(t)
                            """, course=course_code, sid=s["id"], tid=topic_id)
                            
                            sub_count_created += 1
                    
                    actions.append(f"created_module:{mod_id}")
                    actions.append(f"created_topic:{topic_id}")
                    actions.append(f"created_subtopics:{sub_count_created}")
        
        return actions
    
    # 3. Check if course is a lab with 0 subtopics (already a topic but no subtopics)
    #    This is already handled by the NO_SUBTOPICS detection below
    
    # 4. For courses not found in any mega-course, generate auto-curriculum
    with driver.session(database=config.NEO4J_DATABASE) as session:
        course_meta = session.run(
            "MATCH (c:Course {course: $course}) RETURN c.name as name, c.semester as semester, c.category as category",
            course=course_code
        ).single()
    
    if not course_meta:
        print(f"    No Course node or mega-course data for {course_code}. Skipping.")
        actions.append("no_source_data:skipped")
        return actions
    
    course_name = course_meta.get("name", course_code)
    semester = course_meta.get("semester", "")
    category = course_meta.get("category", "")
    
    # Check if it's a lab/practical course
    is_lab = bool(re.search(r'\d2$', course_code)) or "lab" in course_code.lower()
    
    if is_lab or audit_entry.get("status") == "NO_SUBTOPICS":
        # Generate lab subtopics
        subs = get_subtopics_for_course(course_code, course_name)
        
        with driver.session(database=config.NEO4J_DATABASE) as session:
            mod_id = f"module1_{course_code.lower()}"
            session.run("""
                MERGE (m:Module {course: $course, id: $mid})
                SET m.name = $mname, m.order = 1,
                    m.createdAt = datetime(), m.updatedAt = datetime()
            """, course=course_code, mid=mod_id, mname=f"Module 1: {course_name}")
            
            topic_id = course_code.lower() + "___" + re.sub(r'[^a-z0-9_]', '_', course_name.lower()).strip('_')
            session.run("""
                MERGE (t:Topic {course: $course, id: $tid})
                SET t.name = $tname, t.order = 1, t.module_id = $mid,
                    t.createdAt = datetime(), t.updatedAt = datetime()
            """, course=course_code, tid=topic_id, tname=course_name, mid=mod_id)
            
            session.run("""
                MATCH (m:Module {course: $course, id: $mid})
                MATCH (t:Topic {course: $course, id: $tid})
                MERGE (m)-[:HAS_TOPIC]->(t)
            """, course=course_code, mid=mod_id, tid=topic_id)
            
            if subs:
                for i, sub_name in enumerate(subs):
                    sid = course_code.lower() + "___" + re.sub(r'[^a-z0-9_]', '_', sub_name.lower()).strip('_')
                    session.run("""
                        MERGE (sub:Subtopic {course: $course, id: $sid})
                        SET sub.name = $sname, sub.order = $order, sub.topic_id = $tid,
                            sub.createdAt = datetime(), sub.updatedAt = datetime()
                    """, course=course_code, sid=sid, sname=sub_name, order=i+1, tid=topic_id)
                    
                    session.run("""
                        MATCH (sub:Subtopic {course: $course, id: $sid})
                        MATCH (t:Topic {course: $course, id: $tid})
                        MERGE (sub)-[:PREREQUISITE_OF]->(t)
                    """, course=course_code, sid=sid, tid=topic_id)
                
                actions.append(f"created_lab_subtopics:{len(subs)}")
            else:
                # Generate auto-curriculum for non-lab empty courses
                auto = generate_auto_curriculum(course_code, course_name, semester, category)
                for i, sub in enumerate(auto["subtopics"]):
                    session.run("""
                        MERGE (sub:Subtopic {course: $course, id: $sid})
                        SET sub.name = $sname, sub.order = $order, sub.topic_id = $tid,
                            sub.createdAt = datetime(), sub.updatedAt = datetime()
                    """, course=course_code, sid=sub["id"], sname=sub["name"],
                         order=sub["order"], tid=topic_id)
                    
                    session.run("""
                        MATCH (sub:Subtopic {course: $course, id: $sid})
                        MATCH (t:Topic {course: $course, id: $tid})
                        MERGE (sub)-[:PREREQUISITE_OF]->(t)
                    """, course=course_code, sid=sub["id"], tid=topic_id)
                
                actions.append(f"created_auto_subtopics:{len(auto['subtopics'])}")
    
    else:
        # Generate auto-curriculum for non-lab empty courses
        auto = generate_auto_curriculum(course_code, course_name, semester, category)
        
        with driver.session(database=config.NEO4J_DATABASE) as session:
            mod_id = f"module1_{course_code.lower()}"
            session.run("""
                MERGE (m:Module {course: $course, id: $mid})
                SET m.name = $mname, m.order = 1,
                    m.createdAt = datetime(), m.updatedAt = datetime()
            """, course=course_code, mid=mod_id, mname=auto["module"])
            
            topic_id = auto["topic_id"]
            session.run("""
                MERGE (t:Topic {course: $course, id: $tid})
                SET t.name = $tname, t.order = 1, t.module_id = $mid,
                    t.createdAt = datetime(), t.updatedAt = datetime()
            """, course=course_code, tid=topic_id, tname=auto["topic"], mid=mod_id)
            
            session.run("""
                MATCH (m:Module {course: $course, id: $mid})
                MATCH (t:Topic {course: $course, id: $tid})
                MERGE (m)-[:HAS_TOPIC]->(t)
            """, course=course_code, mid=mod_id, tid=topic_id)
            
            for sub in auto["subtopics"]:
                session.run("""
                    MERGE (sub:Subtopic {course: $course, id: $sid})
                    SET sub.name = $sname, sub.order = $order, sub.topic_id = $tid,
                        sub.createdAt = datetime(), sub.updatedAt = datetime()
                """, course=course_code, sid=sub["id"], sname=sub["name"],
                     order=sub["order"], tid=topic_id)
                
                session.run("""
                    MATCH (sub:Subtopic {course: $course, id: $sid})
                    MATCH (t:Topic {course: $course, id: $tid})
                    MERGE (sub)-[:PREREQUISITE_OF]->(t)
                """, course=course_code, sid=sub["id"], tid=topic_id)
            
            actions.append(f"created_auto_curriculum:{len(auto['subtopics'])} subtopics")
    
    return actions

def generate_missing_lectures(driver, course_code):
    """Trigger lecture generation for a course via the RAG batch endpoint."""
    try:
        r = requests.post(
            f"{RAG_URL}/curriculum/{course_code}/lecture/batch-generate",
            json={"force": False},
            timeout=5
        )
        if r.status_code == 200:
            return [f"lecture_batch_triggered"]
        else:
            return [f"lecture_batch_failed:{r.status_code}"]
    except Exception as e:
        return [f"lecture_batch_error:{e}"]

def main():
    driver = get_driver()
    driver.verify_connectivity()
    print(f"Connected to Neo4j at {config.NEO4J_URI}")
    
    # Load audit
    audit_path = os.path.join(os.path.dirname(__file__), "..", "course_audit.json")
    with open(audit_path) as f:
        audit = json.load(f)
    
    courses = audit["courses"]
    
    print(f"\nLoaded {len(courses)} courses from audit.")
    print(f"Need repair: {audit['partial']} partial + {audit['empty']} empty = {audit['partial'] + audit['empty']}")
    print()
    
    # Categorize what needs repair
    to_repair = []
    for c in courses:
        if c["status"] in ("EMPTY", "NO_SUBTOPICS", "NO_LECTURES", "PARTIAL_LECTURES"):
            to_repair.append(c)
    
    print(f"Courses needing repair: {len(to_repair)}")
    print()
    
    repair_results = {
        "timestamp": datetime.now().isoformat(),
        "courses_repaired": 0,
        "courses_skipped": 0,
        "actions": [],
        "lecture_batch_triggered": [],
        "errors": [],
        "details": {}
    }
    
    # Phase 1: Repair hierarchy (Modules/Topics/Subtopics)
    for i, c in enumerate(to_repair):
        course_code = c["course"]
        status = c["status"]
        
        needs_repair = status in ("EMPTY", "NO_SUBTOPICS")
        
        if not needs_repair:
            print(f"[{i+1}/{len(to_repair)}] {course_code}: {status} → skipping (hierarchy OK, just needs lectures)")
            repair_results["details"][course_code] = {"hierarchy_repair": "skipped_ok"}
            continue
        
        print(f"[{i+1}/{len(to_repair)}] {course_code}: {status} → repairing...", end=" ", flush=True)
        try:
            actions = repair_course(driver, course_code, c)
            print(actions if actions else "no changes needed")
            if actions:
                repair_results["courses_repaired"] += 1
            else:
                repair_results["courses_skipped"] += 1
            repair_results["actions"].extend(actions)
            repair_results["details"][course_code] = {"hierarchy_repair": actions}
        except Exception as e:
            print(f"ERROR: {e}")
            repair_results["errors"].append(f"{course_code}: {e}")
            repair_results["details"][course_code] = {"hierarchy_repair": f"error:{e}"}
    
    # Phase 2: Trigger lecture generation for all NO_LECTURES courses
    print("\n=== Phase 2: Batch lecture generation ===")
    lecture_candidates = [c["course"] for c in courses if c["status"] in ("NO_LECTURES", "PARTIAL_LECTURES")]
    print(f"Triggering lecture generation for {len(lecture_candidates)} courses...")
    
    for course_code in lecture_candidates:
        print(f"  {course_code}...", end=" ", flush=True)
        actions = generate_missing_lectures(driver, course_code)
        print(actions)
        if "lecture_batch_triggered" in actions:
            repair_results["lecture_batch_triggered"].append(course_code)
        else:
            repair_results["errors"].append(f"{course_code}: lecture batch failed")
    
    # Final summary
    print(f"\n=== Repair Complete ===")
    print(f"Courses repaired (hierarchy): {repair_results['courses_repaired']}")
    print(f"Courses skipped: {repair_results['courses_skipped']}")
    print(f"Lecture batch triggered: {len(repair_results['lecture_batch_triggered'])}")
    print(f"Errors: {len(repair_results['errors'])}")
    
    # Save report
    with open(REPORT_FILE, "w") as f:
        json.dump(repair_results, f, indent=2, default=str)
    print(f"Report saved to {REPORT_FILE}")
    
    # Phase 3: Final audit
    print("\n=== Phase 3: Running final audit ===")
    # Re-run audit
    from audit_courses import audit_course
    import asyncio
    
    final_results = []
    for c in courses:
        course_code = c["course"]
        print(f"  Re-auditing {course_code}...", end=" ", flush=True)
        try:
            result = asyncio.run(audit_course(course_code, driver))
            final_results.append(result)
            ac = result.get("api_counts", {})
            li = result.get("lecture_info", {})
            cached = li.get("cached_lectures", 0) if li else 0
            print(f"{result['status']:20s} M:{ac.get('modules',0)} T:{ac.get('topics',0)} S:{ac.get('subtopics',0)} L:{cached}")
        except Exception as e:
            print(f"ERROR: {e}")
            final_results.append({"course": course_code, "status": "ERROR", "error": str(e)})
    
    # Summary
    from collections import Counter
    statuses = Counter(r["status"] for r in final_results)
    total_subs = sum(
        r.get("api_counts", {}).get("subtopics", 0) for r in final_results
    )
    total_lectures = sum(
        r.get("lecture_info", {}).get("cached_lectures", 0) for r in final_results if r.get("lecture_info")
    )
    
    final_summary = {
        "timestamp": datetime.now().isoformat(),
        "total_courses": len(final_results),
        "by_status": dict(statuses),
        "total_complete": statuses.get("COMPLETE", 0),
        "total_subtopics": total_subs,
        "total_lectures_cached": total_lectures,
        "repaired": repair_results,
        "courses": final_results
    }
    
    final_path = os.path.join(os.path.dirname(__file__), "..", "course_audit_final.json")
    with open(final_path, "w") as f:
        json.dump(final_summary, f, indent=2, default=str)
    
    print(f"\n{'='*60}")
    print("FINAL VALIDATION")
    print(f"{'='*60}")
    print(f"Total courses: {final_summary['total_courses']}")
    print(f"Complete: {final_summary['total_complete']}")
    for s, cnt in sorted(statuses.items()):
        print(f"  {s}: {cnt}")
    print(f"Total subtopics: {total_subs}")
    print(f"Total lectures cached: {total_lectures}")
    print(f"Courses repaired (hierarchy): {repair_results['courses_repaired']}")
    print(f"Errors: {len(repair_results['errors'])}")
    
    driver.close()

if __name__ == "__main__":
    main()
