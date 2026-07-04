# server/rag_service/curriculum_generator.py
import json
import logging
from typing import Dict, List, Optional, Callable
import curriculum_graph_handler

# Import Provider Manager
try:
    from llm_provider_manager import get_llm_manager, reset_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logging.getLogger(__name__).warning("Provider Manager not available")

logger = logging.getLogger(__name__)

CURRICULUM_GENERATION_PROMPT = """You are an expert academic curriculum designer. 
Your task is to analyze the provided text and extract a structured, hierarchical curriculum.

The output MUST be a valid JSON object with the following structure:
{{
  "modules": [
    {{
      "name": "Module Name (e.g., Introduction to Neural Networks)",
      "order": 1,
      "topics": [
        {{
          "name": "Topic Name (e.g., Perceptrons)",
          "subtopics": ["Subtopic 1", "Subtopic 2"]
        }}
      ]
    }}
  ]
}}

Instructions:
1. Identify 3-5 main modules that logically group the content.
2. For each module, identify 2-4 key topics.
3. for each topic, identify 2-3 specific subtopics or concepts.
4. Ensure the output is ONLY the JSON object, no other text.

TEXT TO ANALYZE:
{text}
"""

def generate_curriculum_from_text(text: str, course_name: str, llm_fn: Optional[Callable] = None) -> Dict:
    """
    Extracts curriculum structure from text using an LLM and saves it to Neo4j.
    
    Args:
        text: The source document text.
        course_name: The name of the subject/document.
        llm_fn: A function that takes a prompt and returns LLM output string.
                If None, uses the Provider Manager.
    """
    try:
        if not text or len(text.strip()) < 100:
            logger.warning(f"Text too short for curriculum extraction: {course_name}")
            return {"success": False, "error": "Text too short"}

        # Truncate text if it's too long for the LLM
        prompt = CURRICULUM_GENERATION_PROMPT.format(text=text[:15000])
        
        # Use Provider Manager if no llm_fn provided
        if llm_fn is None and _PROVIDER_MANAGER_AVAILABLE:
            manager = get_llm_manager()
            provider = manager.get_healthy_provider()
            if provider:
                def _provider_llm(p: str) -> str:
                    result = provider.generate(
                        messages=[{"role": "user", "content": p}],
                        model="",
                        temperature=0.3,
                        max_tokens=4000,
                    )
                    return result or ""
                response_text = _provider_llm(prompt)
            else:
                logger.warning("No healthy provider found for curriculum generation")
                return {"success": False, "error": "No LLM provider available"}
        elif llm_fn is not None:
            response_text = llm_fn(prompt)
        else:
            logger.warning("No llm_fn provided and Provider Manager unavailable")
            return {"success": False, "error": "No LLM provider available"}
        logger.error(f"DEBUG: LLM RAW RESPONSE: {response_text[:500]}...")
        
        # Robust JSON extraction
        import re
        json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
        if json_match:
            response_text = json_match.group(0)
        else:
            # Fallback to existing cleaning logic
            if "```json" in response_text:
                response_text = response_text.split("```json")[1].split("```")[0].strip()
            elif "```" in response_text:
                response_text = response_text.split("```")[1].split("```")[0].strip()
        
        logger.error(f"DEBUG: EXTRACTED JSON: {response_text[:500]}...")
        curriculum_data = json.loads(response_text)
        
        # Transform extracted data into format expected by curriculum_graph_handler
        modules = []
        topics = []
        subtopics = []
        
        for m_idx, m in enumerate(curriculum_data.get('modules', []), 1):
            m_name = m.get('name', f"Module {m_idx}")
            m_id = curriculum_graph_handler.normalize_id(m_name)
            
            modules.append({
                'id': m_id,
                'name': m_name,
                'order': m.get('order', m_idx)
            })
            
            for t_idx, t in enumerate(m.get('topics', []), 1):
                t_name = t.get('name', f"Topic {t_idx}")
                t_id = curriculum_graph_handler.normalize_id(f"{m_id}_{t_name}")
                
                topics.append({
                    'id': t_id,
                    'name': t_name,
                    'module_id': m_id,
                    'lecture_number': t_idx # Simple ordering
                })
                
                for st_name in t.get('subtopics', []):
                    st_id = curriculum_graph_handler.normalize_id(f"{t_id}_{st_name}")
                    subtopics.append({
                        'id': st_id,
                        'name': st_name,
                        'topic_id': t_id
                    })
        
        # Build the graph in Neo4j
        result = curriculum_graph_handler.build_curriculum_graph(
            course_name, modules, topics, subtopics
        )
        
        return {
            "success": True, 
            "modules_count": len(modules),
            "topics_count": len(topics),
            "subtopics_count": len(subtopics)
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        logger.error(f"Failed to generate curriculum for {course_name}: {e}", exc_info=True)
        return {"success": False, "error": str(e)}
