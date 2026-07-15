#!/usr/bin/env python3
"""
iMentor EE Courses Batch Bootstrap
==================================
Batch processes all Electrical Engineering (EE) theory courses generated
in the course_bootstrap/ directory, running the full ingestion, Neo4j,
and STN (Subtopic Teaching Notes) creation pipelines.
"""

import os
import sys
import logging

# Ensure root directory is in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bootstrap_course import bootstrap

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ee_batch_bootstrap")

def run_ee_pipeline():
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "server", "course_bootstrap"))
    
    if not os.path.isdir(base_dir):
        logger.error(f"Bootstrap directory not found at: {base_dir}")
        sys.exit(1)
        
    logger.info(f"Scanning for EE courses under: {base_dir}")
    
    # Discover all EE courses
    ee_courses = []
    for entry in sorted(os.listdir(base_dir)):
        if entry.startswith("EE") and os.path.isdir(os.path.join(base_dir, entry)):
            ee_courses.append(entry)
            
    if not ee_courses:
        logger.warning("No generated EE courses found. Run generate_ee_syllabi.py first.")
        sys.exit(0)
        
    logger.info(f"Discovered {len(ee_courses)} EE course(s) to process:")
    for course in ee_courses:
        logger.info(f"  - {course}")
        
    # Process each course
    for course_name in ee_courses:
        course_dir = os.path.join(base_dir, course_name)
        materials_dir = os.path.join(course_dir, "materials")
        
        logger.info(f"\n>>> Starting Pipeline for: {course_name} <<<")
        try:
            # We run both RAG and Lecture pipelines for a unified synergy
            bootstrap(
                course_name=course_name,
                course_dir=course_dir,
                materials_dir=materials_dir,
                skip_rag=False,
                skip_lecture=False,
                output_root="",
                rag_url=os.getenv("PYTHON_RAG_SERVICE_URL", "http://localhost:2001"),
            )
            logger.info(f"Successfully processed course: {course_name}")
        except Exception as e:
            logger.error(f"Error bootstrapping course {course_name}: {e}", exc_info=True)

if __name__ == "__main__":
    run_ee_pipeline()
