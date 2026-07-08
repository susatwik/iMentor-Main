"""
Register every EE R24 curriculum course as an independent course in Neo4j.
Creates Course nodes linked to existing EE Topic nodes.
"""

import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import neo4j_handler as nh
import requests
from config import NEO4J_DATABASE

# =============================================================================
# COMPLETE COURSE DATA FROM R24 PDF
# =============================================================================

COURSES = [
    # === Semester I-I ===
    {"code": "MA1011", "name": "Principles of Differential and Integral Calculus", "semester": "I-I", "credits": 3, "category": "BSC", "dept": "MA"},
    {"code": "EE1011", "name": "Basic Electrical Circuits", "semester": "I-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "PH1021", "name": "Physics for Electrical Engineering", "semester": "I-I", "credits": 3, "category": "BSC", "dept": "PH"},
    {"code": "ME1021", "name": "Basics of Mechanical Engineering", "semester": "I-I", "credits": 2, "category": "ESC", "dept": "ME"},
    {"code": "CS1031", "name": "Problem Solving through Computer Programming", "semester": "I-I", "credits": 3, "category": "ESC", "dept": "CS"},
    {"code": "CS1032", "name": "Problem Solving through Computer Programming Lab", "semester": "I-I", "credits": 2, "category": "ESC", "dept": "CS"},
    {"code": "PE1012", "name": "Physical Education I", "semester": "I-I", "credits": 1, "category": "HSC", "dept": "PE"},

    # === Semester I-II ===
    {"code": "HS1011", "name": "English for Engineers-I", "semester": "I-II", "credits": 2, "category": "HSC", "dept": "HS"},
    {"code": "MA1021", "name": "Matrices and Differential Equations", "semester": "I-II", "credits": 3, "category": "BSC", "dept": "MA"},
    {"code": "CY1021", "name": "Chemistry of Energy Systems", "semester": "I-II", "credits": 2, "category": "BSC", "dept": "CY"},
    {"code": "EE1021", "name": "Analog Electronics", "semester": "I-II", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE1031", "name": "Electrical Network Analysis", "semester": "I-II", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "CS2101", "name": "Data Structures and Applications", "semester": "I-II", "credits": 3, "category": "ESC", "dept": "CS"},
    {"code": "CS2102", "name": "Data Structures and Applications Lab", "semester": "I-II", "credits": 1, "category": "ESC", "dept": "CS"},
    {"code": "ME1013", "name": "Engineering Graphics with CAD", "semester": "I-II", "credits": 1, "category": "ESC", "dept": "ME"},
    {"code": "PE1022", "name": "Physical Education II", "semester": "I-II", "credits": 1, "category": "HSC", "dept": "PE"},

    # === Semester II-I ===
    {"code": "EE2011", "name": "Measurements and Instrumentation", "semester": "II-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE2021", "name": "DC Machines and Transformers", "semester": "II-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE2031", "name": "Power System Generation and Transmission", "semester": "II-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE2041", "name": "Digital Electronics", "semester": "II-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "MA2051", "name": "Complex Variables and Mathematical Methods", "semester": "II-I", "credits": 3, "category": "BSC", "dept": "MA"},
    {"code": "EE2012", "name": "Analog and Digital Circuits Lab", "semester": "II-I", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "EE2022", "name": "Circuits and Measurements Lab", "semester": "II-I", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "HS2012", "name": "NCC/Social Services", "semester": "II-I", "credits": 1, "category": "HSC", "dept": "HS"},

    # === Semester II-II ===
    {"code": "EC1521", "name": "Signals and Systems for Electrical Engineers", "semester": "II-II", "credits": 3, "category": "ESC", "dept": "EC"},
    {"code": "HS2011", "name": "Personality Development", "semester": "II-II", "credits": 1, "category": "HSC", "dept": "HS"},
    {"code": "PE2012", "name": "Yoga", "semester": "II-II", "credits": 1, "category": "HSC", "dept": "PE"},
    {"code": "EE2051", "name": "AC Rotating Machines", "semester": "II-II", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE2061", "name": "Control Systems", "semester": "II-II", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE2071", "name": "Power Systems Analysis", "semester": "II-II", "credits": 4, "category": "PCC", "dept": "EE"},
    {"code": "EE2010", "name": "Minor Project (Audit Course) - I", "semester": "II-II", "credits": 0, "category": "PCC", "dept": "EE"},
    {"code": "EE2032", "name": "DC Machines and Transformers Lab", "semester": "II-II", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "MA2092", "name": "Numerical Methods Lab", "semester": "II-II", "credits": 1, "category": "BSC", "dept": "MA"},

    # === Semester III-I ===
    {"code": "EE3011", "name": "Power Electronics", "semester": "III-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE3021", "name": "Power System Protection and Control", "semester": "III-I", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "SM3021", "name": "Design Thinking", "semester": "III-I", "credits": 1, "category": "HSC", "dept": "SM"},
    {"code": "EE2042", "name": "Control Systems Lab", "semester": "III-I", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "EE2052", "name": "AC Rotating Machines Lab", "semester": "III-I", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "EE2062", "name": "Power Systems & Renewable Energy Lab", "semester": "III-I", "credits": 2, "category": "PCC", "dept": "EE"},

    # === Semester III-II ===
    {"code": "EE3031", "name": "Embedded Systems", "semester": "III-II", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "EE3041", "name": "Electric Power Drives", "semester": "III-II", "credits": 3, "category": "PCC", "dept": "EE"},
    {"code": "SM3011", "name": "Introduction to Entrepreneurship", "semester": "III-II", "credits": 1, "category": "HSC", "dept": "SM"},
    {"code": "EE3012", "name": "Power Electronics Lab", "semester": "III-II", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "EE3022", "name": "Embedded Systems Lab", "semester": "III-II", "credits": 1, "category": "PCC", "dept": "EE"},
    {"code": "EE3010", "name": "Minor Project (Audit Course)-II", "semester": "III-II", "credits": 0, "category": "PCC", "dept": "EE"},

    # === Semester IV-I ===
    {"code": "EE3032", "name": "Electric Power Drives Lab", "semester": "IV-I", "credits": 2, "category": "PCC", "dept": "EE"},
    {"code": "EE4014", "name": "Professional Major Work", "semester": "IV-I", "credits": 6, "category": "PRC", "dept": "EE"},

    # === Semester IV-II ===
    {"code": "EE4024", "name": "Semester-Long Internship", "semester": "IV-II", "credits": 6, "category": "SLI", "dept": "EE"},

    # === Department Electives (DEC) ===
    # DEC-I (Semester II-II)
    {"code": "EE2601", "name": "Basics of Internet of Things", "semester": "II-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE2611", "name": "Renewable Power Generation", "semester": "II-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE2621", "name": "Introduction to Machine Learning", "semester": "II-II", "credits": 3, "category": "DEC", "dept": "EE"},

    # DEC-II (Semester III-I)
    {"code": "EE3601", "name": "Advanced Control Systems", "semester": "III-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3611", "name": "Wind and Solar Electrical Systems", "semester": "III-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3621", "name": "Digital Signal Processing", "semester": "III-I", "credits": 3, "category": "DEC", "dept": "EE"},

    # DEC-III (Semester III-I)
    {"code": "EE3631", "name": "Soft Computing Techniques", "semester": "III-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3641", "name": "Introduction to Electric Vehicles", "semester": "III-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3651", "name": "Advanced Computer Methods in Power Systems", "semester": "III-I", "credits": 3, "category": "DEC", "dept": "EE"},

    # DEC-IV (Semester III-II)
    {"code": "EE3661", "name": "Advanced Power Electronics", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3671", "name": "Industrial Instrumentation and Automation", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3681", "name": "Converters for Renewable Energy Systems", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},

    # DEC-V (Semester III-II)
    {"code": "EE3691", "name": "Deep Learning Algorithms", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3701", "name": "Electrical Machine Design", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3711", "name": "Introduction to Smart Grid", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3721", "name": "Battery Energy Storage and EV Charging Systems", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3731", "name": "Power System Security and Reliability", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE3741", "name": "Switched Mode Power Supplies", "semester": "III-II", "credits": 3, "category": "DEC", "dept": "EE"},

    # DEC-VI (Semester IV-I)
    {"code": "EE4601", "name": "Energy Management and Audit", "semester": "IV-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE4611", "name": "Power Quality Improvement", "semester": "IV-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE4621", "name": "Distribution System Planning and Automation", "semester": "IV-I", "credits": 3, "category": "DEC", "dept": "EE"},
    {"code": "EE4631", "name": "Special Machines", "semester": "IV-I", "credits": 3, "category": "DEC", "dept": "EE"},

    # === Service Courses (EE to other depts) ===
    {"code": "EE1611", "name": "Basics of Electrical Engineering (for Civil Engineering)", "semester": "I-I", "credits": 3, "category": "ESC", "dept": "EE"},
    {"code": "EE1621", "name": "Introduction to Electrical & Electronics Engineering (for Mechanical Engg.)", "semester": "I-I", "credits": 3, "category": "ESC", "dept": "EE"},

    # === HSC Electives (Semester III-II and IV-I) ===
    {"code": "HS3011", "name": "English for Engineers II", "semester": "III-II", "credits": 3, "category": "HSC", "dept": "HS"},
    {"code": "HS3081", "name": "Vedic Maths", "semester": "III-II", "credits": 3, "category": "HSC", "dept": "HS"},
    {"code": "HS3021", "name": "German/Other Foreign Languages", "semester": "III-II", "credits": 2, "category": "HSC", "dept": "HS"},
]

def normalize_course_id(code):
    """Convert EE1011 to ee1011, matching topic ID convention."""
    return code.lower()

def create_course_node(driver, course):
    """Create a Course node in Neo4j."""
    code = course["code"]
    course_id = normalize_course_id(code)
    
    with driver.session(database=NEO4J_DATABASE) as session:
        # Check if Course node already exists
        existing = session.run(
            "MATCH (c:Course {course: $code}) RETURN c",
            code=code
        ).single()
        
        if existing:
            print(f"  ⏭️  {code}: already exists")
            return False
        
        # Find the corresponding EE topic (topic IDs are like ee1011___basic_electrical_circuits)
        topic = session.run(
            "MATCH (t:Topic {course:'EE'}) WHERE t.id STARTS WITH $topic_id OR t.id = $topic_id RETURN t",
            topic_id=course_id
        ).single()
        
        has_topic = topic is not None
        
        # Create Course node
        session.run("""
            CREATE (c:Course {
                course: $code,
                name: $name,
                semester: $semester,
                credits: $credits,
                category: $category,
                department: $dept,
                code: $code,
                searchable_name: toLower($name + ' ' + $code),
                keywords: $keywords,
                created_at: datetime()
            })
            """,
            code=code,
            name=course["name"],
            semester=course["semester"],
            credits=course["credits"],
            category=course["category"],
            dept=course["dept"],
            keywords=f"{code} {course['name']} {course['semester']} {course['category']} {course['dept']}"
        )
        
        # Link to EE topic if exists
        if has_topic:
            session.run("""
                MATCH (c:Course {course: $code})
                MATCH (t:Topic {course:'EE', id: $topic_id})
                CREATE (c)-[:REFERENCES_TOPIC]->(t)
                """,
                code=code,
                topic_id=course_id
            )
        
        return True

def main():
    driver = nh.get_driver_instance()
    
    print(f"Registering {len(COURSES)} courses from R24 EE curriculum...")
    print()
    
    created = 0
    existing = 0
    errors = 0
    
    for course in COURSES:
        try:
            if create_course_node(driver, course):
                created += 1
                print(f"  ✅ {course['code']}: {course['name'][:50]} ({course['semester']}, {course['credits']}cr)")
            else:
                existing += 1
        except Exception as e:
            errors += 1
            print(f"  ❌ {course['code']}: {e}")
    
    print()
    print(f"Created: {created}, Already existed: {existing}, Errors: {errors}")
    print(f"Total courses: {created + existing}")
    
    # Verify
    print()
    print("Verifying Course nodes...")
    with driver.session(database=NEO4J_DATABASE) as session:
        r = session.run("MATCH (c:Course) RETURN count(c) AS cnt")
        total = r.single()['cnt']
        r = session.run("MATCH (c:Course)-[:REFERENCES_TOPIC]->() RETURN count(c) AS cnt")
        linked = r.single()['cnt']
        print(f"  Total Course nodes: {total}")
        print(f"  Linked to EE topics: {linked}")
        print(f"  Unlinked: {total - linked}")

if __name__ == "__main__":
    main()
