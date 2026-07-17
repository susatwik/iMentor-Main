"""
Focused curriculum repair — only fixes what's broken, never duplicates.

Two categories of broken courses:
  A) 25 orphan topics in EE mega-course (have Topic nodes but no Module HAS_TOPIC link)
  B) 12 courses with no mega-course topic at all (need auto-generated curriculum)

Additionally, lab courses with 0 subtopics get meaningful experiment-based subtopics.
All operations are idempotent.
"""
import os, sys, json, re, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from neo4j import GraphDatabase
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7688")
NEO4J_USER = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASS = os.environ.get("NEO4J_PASSWORD", "password")
NEO4J_DB = os.environ.get("NEO4J_DATABASE", "neo4j")

REPORT_FILE = os.path.join(os.path.dirname(__file__), "..", "repair_report.json")

def get_driver():
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))

# =========================================================================
# Lab subtopic templates (matching course code prefix → topic name patterns)
# =========================================================================
LAB_SUBTOPICS = {
    "ee2012": ["Diode VI Characteristics","Transistor Biasing","Op-Amp Applications","Combinational Logic","Sequential Circuits","Counters and Registers","ADC/DAC","Circuit Simulation","PCB Design","Viva Voce"],
    "ee2022": ["Wheatstone Bridge","Maxwell Bridge","Schering Bridge","Calibration of Meters","Power Measurement","Energy Meter","CRO Measurements","LVDT Characteristics","Strain Gauge","Thermocouple"],
    "ee2042": ["DC Servo Motor","AC Servo Motor","Step Response Analysis","Frequency Response","Root Locus","PID Tuning","State Space","Lead-Lag Compensator","Digital Control","Mini Project"],
    "ee2052": ["No-Load Test","Blocked Rotor Test","Load Test on IM","Synchronous Gen Test","V-Curves of SM","Slip Test","VFD Speed Control","Alternator Parallel","Power Factor Correction","BLDC Performance"],
    "ee2062": ["Load Flow Analysis","Symmetrical Fault","Unsymmetrical Fault","Economic Load Dispatch","Unit Commitment","Transmission Parameters","Solar PV","Wind Turbine","Battery Storage","Grid Inverter"],
    "ee3012": ["SCR Characteristics","MOSFET/IGBT","Half-Controlled Rectifier","Full-Controlled Rectifier","Three-Phase Rectifier","Buck Converter","Boost Converter","Single-Phase Inverter","Three-Phase Inverter","PWM Techniques"],
    "ee3022": ["MCU GPIO","Timer/Counter","PWM Generation","ADC Interfacing","UART Comm","I2C Sensors","SPI Display","Interrupts","RTC","Power Management"],
    "cs2102": ["Array Sorting","Linked List Ops","Stack/Queue","BST Operations","BFS/DFS","Hashing","Heap","AVL Rotations","Priority Queue","Complexity Analysis"],
    "ee3032": ["DC Chopper","Four-Quadrant Drive","VSI Control","V/f Control","Rotor Resistance","Regen Braking","FOC PMSM","Stepper Motor","BLDC Drive","Load Analysis"],
}

def get_lab_subtopics(course_code):
    """Return lab subtopics for a course code, or generic defaults."""
    prefix = course_code.lower()
    for key, subs in LAB_SUBTOPICS.items():
        if prefix == key or prefix.startswith(key) or key.startswith(prefix):
            return subs[:]
    return ["Experiment 1: Introduction and Setup","Experiment 2: Basic Measurements","Experiment 3: Characteristic Analysis","Experiment 4: Troubleshooting","Experiment 5: Performance Evaluation","Experiment 6: Advanced Applications","Experiment 7: Design Exercise","Viva Voce and Report"]

# =========================================================================
# Category A: Fix orphan topics — attach them to modules in EE mega-course
# =========================================================================

def fix_orphan_topics(driver):
    """Create Module nodes in EE mega-course for orphan topics without HAS_TOPIC."""
    print("\n=== Category A: Fix orphan topics in EE mega-course ===")
    actions = []

    with driver.session(database=NEO4J_DB) as session:
        orphans = list(session.run("""
            MATCH (t:Topic {course:'EE'})
            WHERE NOT EXISTS { MATCH (t)<-[:HAS_TOPIC]-(:Module) }
            RETURN t.id as tid, t.name as tname
            ORDER BY t.id
        """))

        if not orphans:
            print("  No orphan topics found. ✓")
            return actions

        print(f"  Found {len(orphans)} orphan topics")

        # Group orphans into logical modules
        from collections import OrderedDict
        modules = OrderedDict()

        for o in orphans:
            tid = o["tid"]
            tname = o["tname"]

            # Determine which module this topic belongs to
            if tid.startswith("ee16") or tid.startswith("ee26"):
                # Service courses and early DEC — put in existing module or new one
                if tid.startswith("ee161") or tid.startswith("ee162"):
                    mod_key = "service_courses"
                    mod_name = "Service Courses (EE for Other Departments)"
                elif tid.startswith("ee260"):
                    mod_key = "dec_22"
                    mod_name = "DEC Electives (Semester II-II)"
                elif tid.startswith("ee261"):
                    # Check if ee2611 is already in an existing module
                    mod_key = "dec_22"
                    mod_name = "DEC Electives (Semester II-II)"
                elif tid.startswith("ee262"):
                    mod_key = "dec_22"
                    mod_name = "DEC Electives (Semester II-II)"
                else:
                    mod_key = "service_courses"
                    mod_name = "Service Courses"
            elif tid.startswith("ee36"):
                mod_key = "dec_31"
                mod_name = "DEC Electives (Semester III-I & III-II)"
            elif tid.startswith("ee37"):
                mod_key = "dec_32"
                mod_name = "DEC Electives (Semester III-II)"
            elif tid.startswith("ee46"):
                mod_key = "dec_41"
                mod_name = "DEC Electives (Semester IV-I)"
            elif tid.startswith("hs"):
                mod_key = "hsc_electives"
                mod_name = "HSC Electives"
            else:
                mod_key = "other"
                mod_name = "Other Courses"

            if mod_key not in modules:
                modules[mod_key] = {
                    "name": mod_name,
                    "order": {
                        "service_courses": 9,
                        "dec_22": 10,
                        "dec_31": 11,
                        "dec_32": 12,
                        "dec_41": 13,
                        "hsc_electives": 14,
                        "other": 15
                    }.get(mod_key, 99),
                    "topics": []
                }
            modules[mod_key]["topics"].append({"id": tid, "name": tname})

        for mod_key, mod_data in modules.items():
            # Create Module node
            mod_id = mod_key
            mod_name = mod_data["name"]
            mod_order = mod_data["order"]

            session.run("""
                MERGE (m:Module {course: 'EE', id: $mid})
                SET m.name = $mname, m.order = $morder,
                    m.createdAt = datetime(), m.updatedAt = datetime()
            """, mid=mod_id, mname=mod_name, morder=mod_order)

            # Link each topic to this module
            for t in mod_data["topics"]:
                session.run("""
                    MATCH (t:Topic {course:'EE', id: $tid})
                    MATCH (m:Module {course:'EE', id: $mid})
                    MERGE (m)-[:HAS_TOPIC]->(t)
                """, tid=t["id"], mid=mod_id)

                # Set topic order within module
                session.run("""
                    MATCH (t:Topic {course:'EE', id: $tid})
                    SET t.order = $order
                """, tid=t["id"], order=mod_data["topics"].index(t) + 1)

            actions.append(f"module_created:{mod_key}({len(mod_data['topics'])}topics)")
            print(f"  Created module '{mod_name}' with {len(mod_data['topics'])} topics")

    print(f"  Total actions: {len(actions)}")
    return actions

# =========================================================================
# Category B: Create curriculum for courses with no mega-course topic
# =========================================================================

def generate_curriculum_for_missing(course_code, course_name, semester, category):
    """Generate a minimal Module/Topic/Subtopic hierarchy for a course."""
    words = [w for w in re.sub(r'[^a-zA-Z\s]', '', course_name).split()
             if w.lower() not in ('the','a','an','of','for','and','in','to','with','using','based','via','on','by','at')
             and len(w) > 2]

    is_lab = bool(re.search(r'\d2$', course_code)) or 'lab' in course_name.lower()
    is_minor = 'minor' in course_name.lower() or 'project' in course_name.lower()
    is_internship = 'internship' in course_name.lower()

    if is_lab:
        subs = get_lab_subtopics(course_code)
        if not subs:
            subs = [f"Experiment {i+1}" for i in range(8)]
        topic_name = course_name
        module_name = f"Module 1: {course_name}"

    elif is_minor:
        subs = ["Problem Definition","Literature Review","Design Methodology","Implementation","Testing","Results","Report","Presentation"]
        topic_name = f"{course_name} - Project Work"
        module_name = f"Module 1: {course_name}"

    elif is_internship:
        subs = ["Company Profile","Learning Objectives","Work Log","Technical Skills","Soft Skills","Project Report","Presentation"]
        topic_name = course_name
        module_name = f"Module 1: {course_name}"

    elif category in ('HSC',):
        subs = [f"Introduction to {w}" for w in (words[:5] or [course_name])]
        topic_name = course_name
        module_name = f"Module 1: {course_name}"

    else:
        if len(words) >= 4:
            subs = [f"Introduction to {words[0]}",
                    f"Fundamentals of {words[0]} {words[1] if len(words)>1 else ''}",
                    f"{words[min(2,len(words)-1)]} - Core Concepts",
                    f"{words[min(3,len(words)-1)]} - Advanced Topics",
                    f"Applications of {course_name}",
                    "Review and Assessment"]
        else:
            subs = [f"Introduction to {course_name}",
                    "Fundamental Concepts",
                    "Core Principles",
                    "Advanced Topics",
                    "Practical Applications",
                    "Review"]
        topic_name = course_name
        module_name = f"Module 1: {course_name}"

    return {
        "module_id": f"module1_{course_code.lower()}",
        "module_name": module_name,
        "topic_id": course_code.lower() + "___" + re.sub(r'[^a-z0-9_]', '_', course_name.lower()).strip('_'),
        "topic_name": topic_name,
        "subtopics": [
            {
                "id": course_code.lower() + "___" + re.sub(r'[^a-z0-9_]', '_', s.lower()).strip('_')[:60],
                "name": s,
                "order": i+1
            }
            for i, s in enumerate(subs)
        ]
    }

def create_course_nodes(driver, course_code, curriculum, link_topic_to_ee=False):
    """Create Module/Topic/Subtopic nodes under a specific course code."""
    with driver.session(database=NEO4J_DB) as session:
        # Check if module already exists
        existing = session.run(
            "MATCH (m:Module {course: $course, id: $mid}) RETURN m",
            course=course_code, mid=curriculum["module_id"]
        ).single()
        if existing:
            return ["already_exists"]

        actions = []

        # Create Module
        session.run("""
            CREATE (m:Module {
                course: $course, id: $mid, name: $mname, order: 1,
                createdAt: datetime(), updatedAt: datetime()
            })
        """, course=course_code, mid=curriculum["module_id"],
             mname=curriculum["module_name"])
        actions.append(f"module:{curriculum['module_id']}")

        # Create Topic
        session.run("""
            CREATE (t:Topic {
                course: $course, id: $tid, name: $tname, order: 1,
                module_id: $mid,
                createdAt: datetime(), updatedAt: datetime()
            })
        """, course=course_code, tid=curriculum["topic_id"],
             tname=curriculum["topic_name"], mid=curriculum["module_id"])
        actions.append(f"topic:{curriculum['topic_id']}")

        # Link Module → Topic
        session.run("""
            MATCH (m:Module {course: $course, id: $mid})
            MATCH (t:Topic {course: $course, id: $tid})
            CREATE (m)-[:HAS_TOPIC]->(t)
        """, course=course_code, mid=curriculum["module_id"],
             tid=curriculum["topic_id"])

        # Create Subtopics
        for s in curriculum["subtopics"]:
            session.run("""
                CREATE (sub:Subtopic {
                    course: $course, id: $sid, name: $sname, order: $sorder,
                    topic_id: $tid,
                    createdAt: datetime(), updatedAt: datetime()
                })
            """, course=course_code, sid=s["id"], sname=s["name"],
                 sorder=s["order"], tid=curriculum["topic_id"])

            session.run("""
                MATCH (sub:Subtopic {course: $course, id: $sid})
                MATCH (t:Topic {course: $course, id: $tid})
                CREATE (sub)-[:PREREQUISITE_OF]->(t)
            """, course=course_code, sid=s["id"], tid=curriculum["topic_id"])

        actions.append(f"subtopics:{len(curriculum['subtopics'])}")

        # Also try to link to EE mega-course topic if applicable
        if link_topic_to_ee:
            session.run("""
                MATCH (c:Course {course: $code})
                MATCH (t:Topic {course:'EE'})
                WHERE toLower(t.id) STARTS WITH toLower($prefix)
                MERGE (c)-[:REFERENCES_TOPIC]->(t)
            """, code=course_code, prefix=course_code.lower())

        return actions

# =========================================================================
# Category C: Fix lab courses with 0 subtopics in EE mega-course
# =========================================================================

def fix_empty_subtopics(driver):
    """Create subtopics for lab courses that have 0 subtopics."""
    print("\n=== Category C: Generate missing subtopics for lab courses ===")
    actions = []

    with driver.session(database=NEO4J_DB) as session:
        # Find topics in EE mega-course that have no subtopics
        empty_topics = list(session.run("""
            MATCH (m:Module {course:'EE'})-[:HAS_TOPIC]->(t:Topic)
            WHERE NOT EXISTS { MATCH (:Subtopic)-[:PREREQUISITE_OF]->(t) }
            RETURN t.id as tid, t.name as tname, m.id as mid, m.name as mname
            ORDER BY t.id
        """))

        if not empty_topics:
            print("  No empty lab topics found. ✓")
            return actions

        print(f"  Found {len(empty_topics)} topics with 0 subtopics")

        for et in empty_topics:
            tid = et["tid"]
            tname = et["tname"]
            mid = et["mid"]

            # Extract course code from topic name (e.g., "EE2012 - Analog and Digital Circuits Lab" → "EE2012")
            code_match = re.match(r'(\w{2,4}\d{3,4})', tname)
            course_code = (code_match.group(1) if code_match else tid.split('___')[0]).lower()

            subs = get_lab_subtopics(course_code)

            for i, s in enumerate(subs):
                sid = tid + "___" + re.sub(r'[^a-z0-9_]', '_', s.lower()).strip('_')[:40]

                session.run("""
                    MERGE (sub:Subtopic {course: 'EE', id: $sid})
                    SET sub.name = $sname, sub.order = $order, sub.topic_id = $tid,
                        sub.createdAt = datetime(), sub.updatedAt = datetime()
                """, sid=sid, sname=s, order=i+1, tid=tid)

                session.run("""
                    MATCH (sub:Subtopic {course:'EE', id: $sid})
                    MATCH (t:Topic {course:'EE', id: $tid})
                    MERGE (sub)-[:PREREQUISITE_OF]->(t)
                """, sid=sid, tid=tid)

            actions.append(f"subtopics_added:{tid}({len(subs)}subs)")
            print(f"  Added {len(subs)} subtopics to {tname} ({tid})")

    return actions

# =========================================================================
# Main
# =========================================================================

def main():
    driver = get_driver()
    driver.verify_connectivity()
    print(f"Connected to Neo4j at {NEO4J_URI}")

    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "category_a_orphan_fix": [],
        "category_b_course_creation": [],
        "category_c_subtopics_fix": [],
        "errors": []
    }

    # ---- Phase A: Fix orphan topics ----
    try:
        report["category_a_orphan_fix"] = fix_orphan_topics(driver)
    except Exception as e:
        report["errors"].append(f"Phase A: {e}")
        print(f"  ERROR: {e}")

    # ---- Phase B: Create curriculum for courses with no mega-course topic ----
    print("\n=== Category B: Create curriculum for courses with no mega-course topic ===")
    try:
        with driver.session(database=NEO4J_DB) as session:
            # Courses that have a Course node but no Module nodes and no matching EE topic
            no_source = list(session.run("""
                MATCH (c:Course)
                WHERE NOT EXISTS { MATCH (m:Module {course: c.course}) }
                  AND NOT EXISTS {
                    MATCH (t:Topic {course:'EE'})
                    WHERE toLower(t.id) STARTS WITH toLower(c.course)
                  }
                RETURN c.course as code, c.name as name, c.semester as sem, c.category as cat
                ORDER BY c.code
            """))

        if no_source:
            print(f"  Found {len(no_source)} courses without mega-course counterpart")
            for row in no_source:
                code = row["code"]
                name = row["name"] or code
                sem = row["sem"] or ""
                cat = row["cat"] or ""
                print(f"  Creating curriculum for {code} ({name[:40]})...", end=" ", flush=True)

                try:
                    curriculum = generate_curriculum_for_missing(code, name, sem, cat)
                    actions = create_course_nodes(driver, code, curriculum)
                    report["category_b_course_creation"].append({code: actions})
                    print(actions)
                except Exception as e:
                    report["errors"].append(f"Phase B {code}: {e}")
                    print(f"ERROR: {e}")
        else:
            print("  No courses without mega-course counterpart found. ✓")
    except Exception as e:
        report["errors"].append(f"Phase B: {e}")

    # ---- Phase C: Fix empty subtopics in lab courses ----
    try:
        report["category_c_subtopics_fix"] = fix_empty_subtopics(driver)
    except Exception as e:
        report["errors"].append(f"Phase C: {e}")

    # ---- Summary ----
    print("\n" + "=" * 60)
    print("REPAIR SUMMARY")
    print("=" * 60)
    a = len(report["category_a_orphan_fix"])
    b = len(report["category_b_course_creation"])
    c = len(report["category_c_subtopics_fix"])
    print(f"Phase A (orphan topics linked to modules): {a} actions")
    print(f"Phase B (new courses created):             {b} courses")
    print(f"Phase C (lab subtopics generated):         {c} topics")
    print(f"Errors:                                     {len(report['errors'])}")

    with open(REPORT_FILE, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nReport saved to {REPORT_FILE}")

    # ---- Verify ----
    print("\n=== Verification ===")
    with driver.session(database=NEO4J_DB) as session:
        r1 = session.run("MATCH (t:Topic {course:'EE'}) WHERE NOT EXISTS { (t)<-[:HAS_TOPIC]-(:Module) } RETURN count(t) as c").single()
        print(f"Still orphan topics: {r1['c']}")
        
        r2 = session.run("""
            MATCH (c:Course)
            WHERE NOT EXISTS { MATCH (m:Module {course: c.course}) }
              AND NOT EXISTS {
                MATCH (t:Topic) WHERE toLower(t.id) STARTS WITH toLower(c.course)
              }
            RETURN count(c) as c
        """).single()
        print(f"Still courses without any data: {r2['c']}")

        r3 = session.run("""
            MATCH (m:Module {course:'EE'})-[:HAS_TOPIC]->(t:Topic)
            WHERE NOT EXISTS { MATCH (:Subtopic)-[:PREREQUISITE_OF]->(t) }
            RETURN count(t) as c
        """).single()
        print(f"Still topics with 0 subtopics: {r3['c']}")

    driver.close()

if __name__ == "__main__":
    main()
