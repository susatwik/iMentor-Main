# server/rag_service/curriculum_graph_handler.py
"""
Curriculum Graph Handler - Normalized Module/Topic/Subtopic Schema

Implements the new Neo4j graph structure for curriculum data:
- (:Module) nodes with [:PRECEDES] relationships
- (:Topic) nodes with [:HAS_TOPIC] relationships from Module
- (:Subtopic) nodes with [:PREREQUISITE_OF] relationships to Topic

This module replaces the flat :Concept node structure from syllabus_graph_handler.py
"""

import csv
import logging
from typing import List, Dict, Optional, Tuple
import config

logger = logging.getLogger(__name__)

# Import Neo4j driver management from existing handler
try:
    from neo4j_handler import get_driver_instance
except ImportError:
    logger.error("Failed to import Neo4j driver from neo4j_handler")
    get_driver_instance = None


# ============================================================================
# NEO4J INDEX CREATION
# ============================================================================

def ensure_curriculum_indexes():
    """
    Create composite indexes on Module, Topic, and Subtopic labels for query performance.
    These use (id, course) as the composite key to ensure uniqueness per course.
    """
    if not get_driver_instance:
        logger.warning("Cannot create curriculum indexes: Neo4j driver not available")
        return
    
    index_queries = [
        # Composite indexes for MERGE performance
        "CREATE INDEX module_id_course IF NOT EXISTS FOR (m:Module) ON (m.id, m.course)",
        "CREATE INDEX topic_id_course IF NOT EXISTS FOR (t:Topic) ON (t.id, t.course)",
        "CREATE INDEX subtopic_id_course IF NOT EXISTS FOR (s:Subtopic) ON (s.id, s.course)",
        # Text index for curriculum search
        "CREATE INDEX topic_name IF NOT EXISTS FOR (t:Topic) ON (t.name)",
        "CREATE INDEX subtopic_name IF NOT EXISTS FOR (s:Subtopic) ON (s.name)",
    ]
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            for query in index_queries:
                try:
                    session.run(query)
                except Exception as e:
                    if "already exists" not in str(e).lower():
                        logger.warning(f"Index creation warning: {e}")
        logger.info("Curriculum graph indexes ensured.")
    except Exception as e:
        logger.error(f"Failed to create curriculum indexes: {e}", exc_info=True)


def create_covers_relationships(course: str, user_id: str, document_name: str):
    """
    Link document KnowledgeGraph nodes to curriculum Subtopic/Topic nodes via COVERS relationship.
    
    This bridges the document-level KG (from neo4j_handler) with the curriculum graph:
      (:KnowledgeNode {userId, documentName})-[:COVERS]->(:Subtopic|:Topic {course})
    
    Matching is done via case-insensitive nodeId/name comparison.
    """
    if not get_driver_instance:
        logger.warning("Cannot create COVERS relationships: Neo4j driver not available")
        return 0
    
    cypher = """
    MATCH (kn:KnowledgeNode {userId: $userId})
    WHERE toLower(kn.documentName) = toLower($documentName)
    WITH kn
    OPTIONAL MATCH (st:Subtopic)
    WHERE toLower(st.course) = toLower($course)
      AND (toLower(st.name) CONTAINS toLower(kn.nodeId) OR toLower(kn.nodeId) CONTAINS toLower(st.name))
    WITH kn, COLLECT(DISTINCT st) AS matched_subtopics
    OPTIONAL MATCH (t:Topic)
    WHERE toLower(t.course) = toLower($course)
      AND (toLower(t.name) CONTAINS toLower(kn.nodeId) OR toLower(kn.nodeId) CONTAINS toLower(t.name))
    WITH kn, matched_subtopics, COLLECT(DISTINCT t) AS matched_topics
    UNWIND (matched_subtopics + matched_topics) AS target
    WITH kn, target WHERE target IS NOT NULL
    MERGE (kn)-[:COVERS]->(target)
    RETURN count(*) AS covers_created
    """
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(cypher, userId=user_id, documentName=document_name, course=course)
            record = result.single()
            count = record['covers_created'] if record else 0
            logger.info(f"Created {count} COVERS relationships for doc '{document_name}' → course '{course}'")
            return count
    except Exception as e:
        logger.error(f"Error creating COVERS relationships: {e}", exc_info=True)
        return 0


# ============================================================================
# ID NORMALIZATION
# ============================================================================

def normalize_id(raw_id: str) -> str:
    """
    Normalize an ID to be consistent and safe for Neo4j.
    Lowercase, strip whitespace, replace spaces with underscores.
    """
    if not raw_id:
        return ""
    return raw_id.strip().lower().replace(" ", "_").replace("-", "_")


# ============================================================================
# CSV PARSING
# ============================================================================

def parse_modules_csv(file_path: str) -> List[Dict]:
    """
    Parse modules.csv file.
    
    Expected columns: module_id, module_name, order
    
    Returns:
        List of module dictionaries
    """
    modules = []
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                module_id = normalize_id(row.get('module_id', ''))
                if not module_id:
                    logger.warning(f"Skipping row with missing module_id: {row}")
                    continue
                
                modules.append({
                    'id': module_id,
                    'name': row.get('module_name', '').strip(),
                    'order': int(row.get('order', 0))
                })
        
        # Sort by order
        modules.sort(key=lambda m: m['order'])
        logger.info(f"Parsed {len(modules)} modules from {file_path}")
        return modules
        
    except Exception as e:
        logger.error(f"Error parsing modules CSV: {e}", exc_info=True)
        raise


def parse_topics_csv(file_path: str) -> List[Dict]:
    """
    Parse topics.csv file.
    
    Expected columns: topic_id, topic_name, module_id
    
    Returns:
        List of topic dictionaries
    """
    topics = []
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                topic_id = normalize_id(row.get('topic_id', ''))
                module_id = normalize_id(row.get('module_id', ''))
                
                if not topic_id:
                    logger.warning(f"Skipping row with missing topic_id: {row}")
                    continue
                
                topics.append({
                    'id': topic_id,
                    'name': row.get('topic_name', '').strip(),
                    'module_id': module_id
                })
        
        logger.info(f"Parsed {len(topics)} topics from {file_path}")
        return topics
        
    except Exception as e:
        logger.error(f"Error parsing topics CSV: {e}", exc_info=True)
        raise


def parse_subtopics_csv(file_path: str) -> List[Dict]:
    """
    Parse subtopics.csv file.
    
    Expected columns: subtopic_id, subtopic_name, topic_id
    
    Returns:
        List of subtopic dictionaries
    """
    subtopics = []
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                subtopic_id = normalize_id(row.get('subtopic_id', ''))
                topic_id = normalize_id(row.get('topic_id', ''))
                
                if not subtopic_id:
                    logger.warning(f"Skipping row with missing subtopic_id: {row}")
                    continue
                
                subtopics.append({
                    'id': subtopic_id,
                    'name': row.get('subtopic_name', '').strip(),
                    'topic_id': topic_id
                })
        
        logger.info(f"Parsed {len(subtopics)} subtopics from {file_path}")
        return subtopics
        
    except Exception as e:
        logger.error(f"Error parsing subtopics CSV: {e}", exc_info=True)
        raise


def parse_unified_csv(file_path: str) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    """
    Parse a single unified CSV file that contains Module, Topic, and Subtopic data.
    
    Expected columns (flexible naming):
    - Module: "Module", "module", "Unit", etc.
    - Lecture Number: "Lecture Number", "lecture_number", "Order", etc.
    - Lecture Topic: "Lecture Topic", "Topic", "lecture_topic", etc.
    - Subtopics: "Subtopics", "subtopics", "Prerequisites", etc. (comma-separated)
    
    This function normalizes the data into separate Module, Topic, and Subtopic lists.
    
    Args:
        file_path: Path to the unified CSV file
    
    Returns:
        Tuple of (modules, topics, subtopics) lists
    """
    modules_dict = {}  # module_name -> {id, name, order}
    topics = []
    subtopics = []
    
    # Try multiple encodings
    encodings_to_try = ['utf-8-sig', 'utf-8', 'latin-1', 'cp1252']
    
    content = None
    for encoding in encodings_to_try:
        try:
            with open(file_path, 'r', encoding=encoding) as f:
                content = f.read()
            logger.info(f"Successfully read CSV with encoding: {encoding}")
            break
        except UnicodeDecodeError:
            continue
    
    if content is None:
        raise ValueError(f"Could not read CSV file with any supported encoding")
    
    # Parse CSV from string
    import io, re
    reader = csv.DictReader(io.StringIO(content))
    
    if not reader.fieldnames:
        raise ValueError("CSV file has no headers")
    
    # Normalize field names for flexible column matching
    field_map = {}
    normalized_fields = {name.strip().lower().replace(' ', '_'): name for name in reader.fieldnames}
    
    # Map to standard names
    module_keys = ['module', 'unit', 'section']
    lecture_num_keys = ['lecture_number', 'lecture', 'order', 'number', 'lecture_no']
    topic_keys = ['lecture_topic', 'topic', 'title', 'name', 'lecture_title']
    subtopic_keys = ['subtopics', 'subtopic', 'prerequisites', 'concepts', 'sub_topics']
    
    def find_column(possible_keys):
        for key in possible_keys:
            if key in normalized_fields:
                return normalized_fields[key]
        return None
    
    module_col = find_column(module_keys)
    lecture_num_col = find_column(lecture_num_keys)
    topic_col = find_column(topic_keys)
    subtopic_col = find_column(subtopic_keys)
    
    logger.info(f"Column mapping: module={module_col}, lecture={lecture_num_col}, topic={topic_col}, subtopics={subtopic_col}")
    
    if not topic_col:
        raise ValueError(f"Could not find topic column. Headers: {reader.fieldnames}")
    
    module_order_counter = {}
    
    for row_num, row in enumerate(reader, start=2):
        # Extract module
        module_name = row.get(module_col, '').strip() if module_col else f"Module {row_num}"
        
        if module_name and module_name not in modules_dict:
            # Assign order based on first appearance
            module_order = len(modules_dict) + 1
            module_id = normalize_id(module_name)
            modules_dict[module_name] = {
                'id': module_id,
                'name': module_name,
                'order': module_order
            }
        
        # Extract topic
        topic_name = row.get(topic_col, '').strip()
        if not topic_name:
            logger.warning(f"Row {row_num}: Missing topic, skipping")
            continue
        
        topic_id = normalize_id(topic_name)
        module_id = normalize_id(module_name) if module_name else None
        
        # Get lecture number for ordering within module
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
            'order': lecture_num if lecture_num else row_num  # Use lecture_number or row order
        })
        
                # Extract subtopics (comma-separated) - PRESERVE ORDER
        if subtopic_col:
            subtopics_str = row.get(subtopic_col, '').strip()
            if subtopics_str:
                # Strip trailing bibliographic sections (Textbooks, References, etc.)
                for marker in ['textbooks:', 'references:', 'reference books:', 'suggested reading',
                               'further reading', 'bibliography', 'department of electrical engineering']:
                    idx = subtopics_str.lower().find(marker)
                    if idx >= 0:
                        subtopics_str = subtopics_str[:idx].strip()
                        if subtopics_str.endswith(','):
                            subtopics_str = subtopics_str[:-1].strip()
                        break
                if not subtopics_str:
                    continue
                # Split by comma and clean each subtopic - order matters!
                subtopic_parts = [s.strip() for s in subtopics_str.split(',') if s.strip()]
                for subtopic_order, subtopic_name in enumerate(subtopic_parts, start=1):
                    # Skip non-curriculum entries
                    stripped = subtopic_name.strip().strip('"').strip("'").strip()
                    if not stripped:
                        continue
                    # Skip reference-like entries
                    lower = stripped.lower()
                    # Publisher name starts (exact or beginning of entry)
                    publisher_prefixes = ('penguin', 'westland', 'springer', 'pearson', 'wiley', 'elsevier',
                        'crc press', 'o\'reilly', 'addison-wesley', 'mcgraw-hill', 'mit press', 'cambridge',
                        'oxford university press', 'prentice hall', 'mcgraw hill', 'oxford', 'excel books',
                        'narus', 'khanna', 'ieee press', 'john wiley', 'taylor and francis', 'narosa',
                        'cengage')
                    if any(lower.startswith(p) for p in publisher_prefixes):
                        continue
                    # Author patterns: "I. Last", "Last I.", "I.I. Last"
                    if re.match(r'^[A-Z][a-z]+\s[A-Z]\.$', stripped) or \
                       re.match(r'^[A-Z]\.\s*[A-Z][a-z]+\s', stripped) or \
                       re.match(r'^[A-Z]\.\s*[A-Z]\.\s*[A-Z][a-z]+', stripped):
                        continue
                    # Years: "2009", "2009. Something"
                    if re.match(r'^\d{4}\b', stripped):
                        continue
                    # Contains year + book/publisher indicator
                    if re.search(r'\d{4}', stripped) and any(p in lower for p in ('edition', 'books', 'publications', 'publishing')):
                        continue
                    # Page markers (e.g. "56 | Page", "54 | Page")
                    if re.match(r'^\d+\s*\|\s*page', lower) or re.search(r'department of electrical engineering', lower):
                        continue
                    # Starts with "and" or "or" (comma-split artifacts)
                    if lower.startswith('and ') or lower.startswith('or '):
                        continue
                    # Edition markers
                    if re.match(r'^\d+\s*(st|nd|rd|th)\s+edition', lower):
                        continue
                    # Known non-curriculum phrases
                    non_curric_phrases = ('b.d.singh', 'l. filby', 'g. kawasaki', 'guy kawasaki',
                        'art of the start', 'battle-hardened guide', 'the lean startup',
                        'connect the dots', 'ries, eric', 'heaton')
                    if any(p in lower for p in non_curric_phrases):
                        continue
                    subtopic_id = normalize_id(stripped)
                    subtopics.append({
                        'id': subtopic_id,
                        'name': stripped,
                        'topic_id': topic_id,
                        'order': subtopic_order  # Preserve comma-order as sequence
                    })
    
    # Convert modules dict to list sorted by order
    modules = sorted(modules_dict.values(), key=lambda m: m['order'])
    
    # Deduplicate subtopics by compound key (subtopic_id, topic_id)
    # The same subtopic name can appear under different topics and must be kept distinct
    seen_subtopics = {}
    unique_subtopics = []
    for st in subtopics:
        compound_key = f"{st['id']}::{st.get('topic_id', '')}"
        if compound_key not in seen_subtopics:
            seen_subtopics[compound_key] = True
            unique_subtopics.append(st)
    
    logger.info(
        f"Parsed unified CSV: {len(modules)} modules, {len(topics)} topics, "
        f"{len(unique_subtopics)} unique subtopics"
    )
    
    return modules, topics, unique_subtopics


def ingest_from_unified_csv(course: str, file_path: str) -> Dict:
    """
    Ingest curriculum from a single unified CSV file.
    
    This is a convenience function that parses the unified CSV and builds the graph.
    
    Args:
        course: Course name
        file_path: Path to the unified CSV file
    
    Returns:
        Result dictionary with counts
    """
    modules, topics, subtopics = parse_unified_csv(file_path)
    return build_curriculum_graph(course, modules, topics, subtopics)


# ============================================================================
# NEO4J GRAPH BUILDING - TRANSACTIONAL FUNCTIONS
# ============================================================================

def _build_modules_transactional(tx, course: str, modules: List[Dict]) -> int:
    """
    Create Module nodes and PRECEDES relationships.
    
    Each module gets a sequential PRECEDES relationship based on order.
    """
    nodes_created = 0
    
    # Create all module nodes
    for module in modules:
        create_query = """
        MERGE (m:Module {id: $id, course: $course})
        ON CREATE SET 
            m.name = $name,
            m.order = $order,
            m.createdAt = datetime()
        ON MATCH SET
            m.name = $name,
            m.order = $order,
            m.updatedAt = datetime()
        RETURN m
        """
        result = tx.run(
            create_query,
            id=module['id'],
            course=course,
            name=module['name'],
            order=module['order']
        )
        if result.single():
            nodes_created += 1
    
    # Create PRECEDES relationships based on order
    for i in range(len(modules) - 1):
        current_module = modules[i]
        next_module = modules[i + 1]
        
        precedes_query = """
        MATCH (m1:Module {id: $current_id, course: $course})
        MATCH (m2:Module {id: $next_id, course: $course})
        MERGE (m1)-[r:PRECEDES]->(m2)
        RETURN r
        """
        tx.run(
            precedes_query,
            current_id=current_module['id'],
            next_id=next_module['id'],
            course=course
        )
    
    return nodes_created


def _build_topics_transactional(tx, course: str, topics: List[Dict]) -> Tuple[int, int]:
    """
    Create Topic nodes and HAS_TOPIC relationships from Module to Topic.
    
    Returns:
        Tuple of (nodes_created, relationships_created)
    """
    nodes_created = 0
    rels_created = 0
    
    for topic in topics:
        # Create topic node with order property for sequencing
        create_query = """
        MERGE (t:Topic {id: $id, course: $course})
        ON CREATE SET 
            t.name = $name,
            t.module_id = $module_id,
            t.order = $order,
            t.createdAt = datetime()
        ON MATCH SET
            t.name = $name,
            t.module_id = $module_id,
            t.order = $order,
            t.updatedAt = datetime()
        RETURN t
        """
        result = tx.run(
            create_query,
            id=topic['id'],
            course=course,
            name=topic['name'],
            module_id=topic['module_id'],
            order=topic.get('order', 0)
        )
        if result.single():
            nodes_created += 1
        
        # Create HAS_TOPIC relationship from Module to Topic
        if topic['module_id']:
            rel_query = """
            MATCH (m:Module {id: $module_id, course: $course})
            MATCH (t:Topic {id: $topic_id, course: $course})
            MERGE (m)-[r:HAS_TOPIC]->(t)
            RETURN r
            """
            result = tx.run(
                rel_query,
                module_id=topic['module_id'],
                topic_id=topic['id'],
                course=course
            )
            if result.single():
                rels_created += 1
    
    return nodes_created, rels_created


def _build_subtopics_transactional(tx, course: str, subtopics: List[Dict]) -> Tuple[int, int]:
    """
    Create Subtopic nodes and PREREQUISITE_OF relationships to Topic.
    
    The relationship direction is: (Subtopic)-[:PREREQUISITE_OF]->(Topic)
    Meaning: You must learn the subtopic before you can master the topic.
    
    Returns:
        Tuple of (nodes_created, relationships_created)
    """
    nodes_created = 0
    rels_created = 0
    
    for subtopic in subtopics:
        # Create subtopic node with order property for sequencing
        create_query = """
        MERGE (s:Subtopic {id: $id, course: $course})
        ON CREATE SET 
            s.name = $name,
            s.topic_id = $topic_id,
            s.order = $order,
            s.createdAt = datetime()
        ON MATCH SET
            s.name = $name,
            s.topic_id = $topic_id,
            s.order = $order,
            s.updatedAt = datetime()
        RETURN s
        """
        result = tx.run(
            create_query,
            id=subtopic['id'],
            course=course,
            name=subtopic['name'],
            topic_id=subtopic['topic_id'],
            order=subtopic.get('order', 0)
        )
        if result.single():
            nodes_created += 1
        
        # Create PREREQUISITE_OF relationship from Subtopic to Topic
        if subtopic['topic_id']:
            rel_query = """
            MATCH (s:Subtopic {id: $subtopic_id, course: $course})
            MATCH (t:Topic {id: $topic_id, course: $course})
            MERGE (s)-[r:PREREQUISITE_OF]->(t)
            RETURN r
            """
            result = tx.run(
                rel_query,
                subtopic_id=subtopic['id'],
                topic_id=subtopic['topic_id'],
                course=course
            )
            if result.single():
                rels_created += 1
    
    return nodes_created, rels_created


# ============================================================================
# PUBLIC API - GRAPH BUILDING
# ============================================================================

def build_curriculum_graph(
    course: str,
    modules: List[Dict],
    topics: List[Dict],
    subtopics: List[Dict]
) -> Dict:
    """
    Build the complete curriculum graph in Neo4j.
    
    Creates:
    - Module nodes with PRECEDES relationships
    - Topic nodes with HAS_TOPIC relationships from Module
    - Subtopic nodes with PREREQUISITE_OF relationships to Topic
    
    Args:
        course: Course name/identifier
        modules: List of module dicts from parse_modules_csv
        topics: List of topic dicts from parse_topics_csv
        subtopics: List of subtopic dicts from parse_subtopics_csv
    
    Returns:
        Result dictionary with counts
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    try:
        # Ensure composite indexes exist before building graph
        ensure_curriculum_indexes()
        
        driver = get_driver_instance()
        
        with driver.session(database=config.NEO4J_DATABASE) as session:
            # Build modules and PRECEDES relationships
            module_count = session.execute_write(
                _build_modules_transactional, course, modules
            )
            
            # Build topics and HAS_TOPIC relationships
            topic_count, has_topic_count = session.execute_write(
                _build_topics_transactional, course, topics
            )
            
            # Build subtopics and PREREQUISITE_OF relationships
            subtopic_count, prereq_count = session.execute_write(
                _build_subtopics_transactional, course, subtopics
            )
        
        result = {
            'success': True,
            'course': course,
            'modules_created': module_count,
            'topics_created': topic_count,
            'subtopics_created': subtopic_count,
            'precedes_relationships': len(modules) - 1 if len(modules) > 1 else 0,
            'has_topic_relationships': has_topic_count,
            'prerequisite_of_relationships': prereq_count
        }
        
        logger.info(
            f"Curriculum graph built for '{course}': "
            f"{module_count} modules, {topic_count} topics, {subtopic_count} subtopics"
        )
        
        return result
        
    except Exception as e:
        logger.error(f"Error building curriculum graph: {e}", exc_info=True)
        raise


def ingest_curriculum_from_csvs(
    course: str,
    modules_csv: str,
    topics_csv: str,
    subtopics_csv: str
) -> Dict:
    """
    Full ingestion pipeline from CSV files to Neo4j graph.
    
    Args:
        course: Course name/identifier
        modules_csv: Path to modules.csv
        topics_csv: Path to topics.csv
        subtopics_csv: Path to subtopics.csv
    
    Returns:
        Result dictionary with counts
    """
    modules = parse_modules_csv(modules_csv)
    topics = parse_topics_csv(topics_csv)
    subtopics = parse_subtopics_csv(subtopics_csv)
    
    return build_curriculum_graph(course, modules, topics, subtopics)


# ============================================================================
# PUBLIC API - QUERY FUNCTIONS
# ============================================================================

def get_topic_prerequisites(course: str, topic_id: str) -> List[Dict]:
    """
    Get all subtopics that are prerequisites for a given topic.
    
    Query direction: (Subtopic)-[:PREREQUISITE_OF]->(Topic)
    
    Args:
        course: Course name
        topic_id: Topic identifier
    
    Returns:
        List of prerequisite subtopic dictionaries
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    normalized_topic_id = normalize_id(topic_id)
    
    query = """
    MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t:Topic {id: $topic_id})
    WHERE toLower(t.course) = toLower($course)
    RETURN s.id AS id, s.name AS name
    ORDER BY s.name
    """
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(query, topic_id=normalized_topic_id, course=course)
            prerequisites = [dict(record) for record in result]
        
        logger.info(f"Found {len(prerequisites)} prerequisites for topic '{topic_id}'")
        return prerequisites
        
    except Exception as e:
        logger.error(f"Error getting topic prerequisites: {e}", exc_info=True)
        raise


def get_next_module(course: str, module_id: str) -> Optional[Dict]:
    """
    Get the next module in sequence.
    
    Query: (current_module)-[:PRECEDES]->(next_module)
    
    Args:
        course: Course name
        module_id: Current module identifier
    
    Returns:
        Next module dictionary or None if no next module
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    normalized_module_id = normalize_id(module_id)
    
    query = """
    MATCH (m1:Module {id: $module_id})-[:PRECEDES]->(m2:Module)
    WHERE toLower(m1.course) = toLower($course)
    RETURN m2.id AS id, m2.name AS name, m2.order AS order
    LIMIT 1
    """
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(query, module_id=normalized_module_id, course=course)
            record = result.single()
            
            if record:
                return dict(record)
            return None
        
    except Exception as e:
        logger.error(f"Error getting next module: {e}", exc_info=True)
        raise


def traverse_curriculum(course: str) -> Dict:
    """
    Get the full curriculum structure: Module → Topic → Subtopic.
    
    Returns a hierarchical structure for display/traversal.
    
    Args:
        course: Course name
    
    Returns:
        Dictionary with modules, topics, and their relationships
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    # Query with proper ORDER BY for modules, topics, AND subtopics
    query = """
    MATCH (m:Module)
    WHERE toLower(m.course) = toLower($course)
    OPTIONAL MATCH (m)-[:HAS_TOPIC]->(t:Topic)
    WHERE t IS NOT NULL
    OPTIONAL MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t)
    WHERE s IS NOT NULL
    WITH m, t, s
    ORDER BY m.order, coalesce(t.order, 0), coalesce(s.order, 0)
    WITH m, t, COLLECT(DISTINCT CASE WHEN s IS NOT NULL AND s.id IS NOT NULL THEN {id: s.id, name: s.name, order: s.order} END) AS subtopics
    WITH m, COLLECT(DISTINCT CASE WHEN t IS NOT NULL AND t.id IS NOT NULL THEN {
        id: t.id,
        name: t.name,
        order: t.order,
        subtopics: [sub IN subtopics WHERE sub IS NOT NULL AND sub.id IS NOT NULL]
    } END) AS topics
    RETURN m.id AS module_id, m.name AS module_name, m.order AS module_order,
           [tp IN topics WHERE tp IS NOT NULL AND tp.id IS NOT NULL] AS topics
    ORDER BY m.order
    """
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(query, course=course)
            
            modules = []
            for record in result:
                # Filter out null topics and sort by order
                topics = sorted(
                    [t for t in record['topics'] if t and t.get('id')],
                    key=lambda t: t.get('order') or 0
                )
                # Filter out null subtopics and sort by order
                for topic in topics:
                    topic['subtopics'] = sorted(
                        [p for p in topic.get('subtopics', []) if p and p.get('id')],
                        key=lambda s: s.get('order') or 0
                    )
                
                modules.append({
                    'id': record['module_id'],
                    'name': record['module_name'],
                    'order': record['module_order'],
                    'topics': topics
                })

            # Final Python-side null ghost guard
            filtered_modules = []
            for module in modules:
                if not module or not module.get('id'):
                    continue
                cleaned_topics = [t for t in module.get('topics', []) if t and t.get('id')]
                for topic in cleaned_topics:
                    topic['subtopics'] = [
                        s for s in topic.get('subtopics', [])
                        if s and s.get('id')
                    ]
                module['topics'] = cleaned_topics
                filtered_modules.append(module)
            modules = filtered_modules
        
        logger.info(f"Traversed curriculum for '{course}': {len(modules)} modules")
        return {
            'course': course,
            'modules': modules
        }
        
    except Exception as e:
        logger.error(f"Error traversing curriculum: {e}", exc_info=True)
        raise


def get_learning_path(course: str, target_topic_id: str) -> List[Dict]:
    """
    Build a dynamic learning path to reach a target topic.
    
    This finds the module containing the topic and all prerequisite subtopics.
    
    Args:
        course: Course name
        target_topic_id: Target topic identifier
    
    Returns:
        Ordered list of items to learn (modules, subtopics, then topic)
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    normalized_topic_id = normalize_id(target_topic_id)
    
    # Get the topic and its module
    topic_query = """
    MATCH (m:Module)-[:HAS_TOPIC]->(t:Topic {id: $topic_id})
    WHERE toLower(m.course) = toLower($course) AND toLower(t.course) = toLower($course)
    RETURN t.id AS topic_id, t.name AS topic_name, m.id AS module_id, m.name AS module_name, m.order AS module_order
    """
    
    # Get all prerequisite subtopics
    prereq_query = """
    MATCH (s:Subtopic)-[:PREREQUISITE_OF]->(t:Topic {id: $topic_id})
    WHERE toLower(t.course) = toLower($course)
    RETURN s.id AS id, s.name AS name
    ORDER BY s.name
    """
    
    # Get preceding modules
    preceding_query = """
    MATCH path = (m1:Module)-[:PRECEDES*]->(m2:Module {id: $module_id})
    WHERE toLower(m1.course) = toLower($course) AND toLower(m2.course) = toLower($course)
    WITH nodes(path) AS modules
    UNWIND modules AS m
    WITH DISTINCT m
    WHERE m.id <> $module_id
    RETURN m.id AS id, m.name AS name, m.order AS order
    ORDER BY m.order
    """
    
    try:
        driver = get_driver_instance()
        learning_path = []
        
        with driver.session(database=config.NEO4J_DATABASE) as session:
            # Get topic info
            topic_result = session.run(topic_query, topic_id=normalized_topic_id, course=course)
            topic_record = topic_result.single()
            
            if not topic_record:
                logger.warning(f"Topic '{target_topic_id}' not found in course '{course}'")
                return []
            
            module_id = topic_record['module_id']
            
            # Get preceding modules
            preceding_result = session.run(
                preceding_query, 
                module_id=module_id, 
                course=course
            )
            for record in preceding_result:
                learning_path.append({
                    'type': 'module',
                    'id': record['id'],
                    'name': record['name'],
                    'order': record['order']
                })
            
            # Add current module
            learning_path.append({
                'type': 'module',
                'id': module_id,
                'name': topic_record['module_name'],
                'order': topic_record['module_order']
            })
            
            # Get prerequisites
            prereq_result = session.run(prereq_query, topic_id=normalized_topic_id, course=course)
            for record in prereq_result:
                learning_path.append({
                    'type': 'subtopic',
                    'id': record['id'],
                    'name': record['name']
                })
            
            # Add target topic
            learning_path.append({
                'type': 'topic',
                'id': topic_record['topic_id'],
                'name': topic_record['topic_name']
            })
        
        logger.info(f"Built learning path to '{target_topic_id}': {len(learning_path)} steps")
        return learning_path
        
    except Exception as e:
        logger.error(f"Error building learning path: {e}", exc_info=True)
        raise


def detect_missing_prerequisites(
    course: str, 
    topic_id: str, 
    completed_subtopic_ids: List[str]
) -> List[Dict]:
    """
    Detect which prerequisites are missing for a topic.
    
    Args:
        course: Course name
        topic_id: Target topic identifier
        completed_subtopic_ids: List of subtopic IDs the learner has completed
    
    Returns:
        List of missing prerequisite subtopics
    """
    all_prerequisites = get_topic_prerequisites(course, topic_id)
    completed_set = {normalize_id(sid) for sid in completed_subtopic_ids}
    
    missing = [p for p in all_prerequisites if p['id'] not in completed_set]
    
    logger.info(
        f"Topic '{topic_id}': {len(all_prerequisites)} total prerequisites, "
        f"{len(missing)} missing"
    )
    
    return missing


# ============================================================================
# COURSE MANAGEMENT
# ============================================================================

def delete_course_curriculum(course: str) -> Dict:
    """
    Delete all curriculum data for a course.
    
    Removes all Module, Topic, and Subtopic nodes and their relationships.
    
    Args:
        course: Course name to delete
    
    Returns:
        Result dictionary with deletion counts
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    query = """
    MATCH (n)
    WHERE (n:Module OR n:Topic OR n:Subtopic) AND toLower(n.course) = toLower($course)
    DETACH DELETE n
    RETURN count(n) AS deleted_count
    """
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(query, course=course)
            record = result.single()
            deleted_count = record['deleted_count'] if record else 0
        
        logger.info(f"Deleted {deleted_count} nodes for course '{course}'")
        return {
            'success': True,
            'course': course,
            'deleted_count': deleted_count
        }
        
    except Exception as e:
        logger.error(f"Error deleting course curriculum: {e}", exc_info=True)
        raise


def gc_orphaned_nodes() -> Dict:
    """
    Garbage-collect orphaned Topic and Subtopic nodes that are no longer connected
    to any Module. These accumulate after partial deletions or failed ingests.

    Returns:
        Result dictionary with deleted_count
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")

    query = """
    MATCH (n)
    WHERE (n:Topic OR n:Subtopic)
      AND NOT (n)<-[:HAS_TOPIC]-(:Module)
      AND NOT (n)-[:PREREQUISITE_OF]->(:Topic)<-[:HAS_TOPIC]-(:Module)
    DETACH DELETE n
    RETURN count(n) AS deleted_count
    """

    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(query)
            record = result.single()
            deleted_count = record['deleted_count'] if record else 0

        logger.info(f"GC orphaned nodes: deleted {deleted_count} dangling Topic/Subtopic nodes")
        return {'success': True, 'deleted_count': deleted_count}

    except Exception as e:
        logger.error(f"Error running orphan GC: {e}", exc_info=True)
        raise


def list_courses() -> List[str]:
    """
    List all courses that have curriculum data.
    
    Returns:
        List of course names
    """
    if not get_driver_instance:
        raise ConnectionError("Neo4j driver not available")
    
    # Primary query: look for curriculum nodes (Module/Topic/Subtopic/Concept)
    query = """
    MATCH (n)
    WHERE n:Module OR n:Topic OR n:Subtopic OR n:Concept
    WITH n.course AS course
    WHERE course IS NOT NULL AND course <> ''
    RETURN DISTINCT course
    ORDER BY course
    """
    
    try:
        driver = get_driver_instance()
        with driver.session(database=config.NEO4J_DATABASE) as session:
            result = session.run(query)
            courses = [record['course'] for record in result]
            
            # If no curriculum nodes found, run diagnostics inside the SAME session
            if not courses:
                logger.warning("list_courses: No curriculum nodes found (Module/Topic/Subtopic/Concept). "
                               "Upload a curriculum CSV via /curriculum/upload to populate courses.")
                
                # Diagnostic: What labels exist in the database?
                try:
                    diag_result = session.run("CALL db.labels() YIELD label RETURN collect(label) AS labels")
                    diag_record = diag_result.single()
                    all_labels = diag_record['labels'] if diag_record else []
                    logger.info(f"list_courses DIAG: All labels in DB: {all_labels}")
                    
                    for label in ['Module', 'Topic', 'Subtopic', 'Concept']:
                        if label in all_labels:
                            count_result = session.run(f"MATCH (n:{label}) RETURN count(n) AS cnt")
                            cnt_record = count_result.single()
                            cnt = cnt_record['cnt'] if cnt_record else 0
                            logger.info(f"list_courses DIAG: :{label} count = {cnt}")
                            
                            if cnt > 0:
                                prop_result = session.run(
                                    f"MATCH (n:{label}) RETURN n.course AS course, count(n) AS cnt LIMIT 5"
                                )
                                for prop_record in prop_result:
                                    logger.info(
                                        f"list_courses DIAG: :{label} course='{prop_record['course']}' count={prop_record['cnt']}"
                                    )
                except Exception as diag_err:
                    logger.warning(f"list_courses DIAG: {diag_err}")
        
        return courses
        
    except Exception as e:
        logger.error(f"Error listing courses: {e}", exc_info=True)
        raise


