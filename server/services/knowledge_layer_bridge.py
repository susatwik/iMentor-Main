# server/services/knowledge_layer_bridge.py
"""
Knowledge Layer Bridge - Connects Neo4j Curriculum Graph with Qdrant Vector Store

This module provides a unified interface to:
1. Query Neo4j for curriculum structure (topics, prerequisites, modules)
2. Query Qdrant for relevant document chunks (semantic search)
3. Combine both for enhanced RAG with curriculum awareness

Architecture:
    ┌─────────────────────────────────────────────────────────────────┐
    │                     KNOWLEDGE LAYER BRIDGE                       │
    │                                                                  │
    │   ┌─────────────────┐         ┌──────────────────────────┐     │
    │   │     Neo4j       │         │         Qdrant           │     │
    │   │  (Curriculum    │◄───────►│    (Document Chunks      │     │
    │   │   Graph)        │         │     Vector Store)        │     │
    │   │                 │         │                          │     │
    │   │ • Modules       │         │ • PDF chunks             │     │
    │   │ • Topics        │         │ • Embeddings             │     │
    │   │ • Subtopics     │         │ • Syllabus metadata      │     │
    │   │ • Prerequisites │         │ • Semantic search        │     │
    │   └─────────────────┘         └──────────────────────────┘     │
    └─────────────────────────────────────────────────────────────────┘
"""

import os
import logging
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class CurriculumTopic:
    """A topic from the Neo4j curriculum graph."""
    topic_id: str
    name: str
    module: str
    subtopics: List[str] = field(default_factory=list)
    prerequisites: List[str] = field(default_factory=list)
    mastery_required: bool = False


@dataclass
class DocumentChunk:
    """A document chunk from Qdrant."""
    chunk_id: str
    content: str
    source_file: str
    page_number: int
    score: float
    syllabus_module: Optional[str] = None
    syllabus_topic: Optional[str] = None


@dataclass
class EnhancedContext:
    """Combined context from both Neo4j and Qdrant."""
    query: str
    curriculum_context: List[CurriculumTopic]
    document_chunks: List[DocumentChunk]
    related_topics: List[str]
    prerequisite_chain: List[str]


class KnowledgeLayerBridge:
    """
    Bridges Neo4j curriculum graph with Qdrant vector store.
    
    Usage:
        bridge = KnowledgeLayerBridge(neo4j_driver, qdrant_client)
        context = await bridge.get_enhanced_context("What is backpropagation?")
    """
    
    def __init__(
        self,
        neo4j_driver: Optional[Any] = None,
        qdrant_client: Optional[Any] = None,
        collection_name: str = "course_materials"
    ):
        """
        Initialize the bridge with Neo4j and Qdrant connections.
        
        Args:
            neo4j_driver: Neo4j driver instance (optional, will try to create)
            qdrant_client: Qdrant client instance (optional, will try to create)
            collection_name: Name of the Qdrant collection
        """
        self.neo4j_driver = neo4j_driver
        self.qdrant_client = qdrant_client
        self.collection_name = collection_name
        
        logger.info("KnowledgeLayerBridge initialized")
    
    async def get_curriculum_topics(self, query: str, limit: int = 5) -> List[CurriculumTopic]:
        """
        Find relevant curriculum topics from Neo4j based on query.
        
        Args:
            query: Search query
            limit: Maximum number of topics to return
            
        Returns:
            List of matching CurriculumTopic objects
        """
        if not self.neo4j_driver:
            logger.warning("Neo4j driver not configured")
            return []
        
        try:
            # Cypher query to find matching topics
            cypher = """
            MATCH (t:Topic)
            WHERE toLower(t.name) CONTAINS toLower($query)
               OR ANY(sub IN t.subtopics WHERE toLower(sub) CONTAINS toLower($query))
            OPTIONAL MATCH (t)-[:PREREQUISITE_OF]->(prereq:Topic)
            OPTIONAL MATCH (m:Module)-[:CONTAINS]->(t)
            RETURN t.id as topic_id, 
                   t.name as name, 
                   m.name as module,
                   t.subtopics as subtopics,
                   collect(prereq.name) as prerequisites
            LIMIT $limit
            """
            
            with self.neo4j_driver.session() as session:
                result = session.run(cypher, query=query, limit=limit)
                topics = []
                for record in result:
                    topics.append(CurriculumTopic(
                        topic_id=record["topic_id"] or "",
                        name=record["name"] or "",
                        module=record["module"] or "General",
                        subtopics=record["subtopics"] or [],
                        prerequisites=record["prerequisites"] or []
                    ))
                return topics
                
        except Exception as e:
            logger.error(f"Error querying Neo4j: {e}")
            return []
    
    async def get_document_chunks(
        self, 
        query: str, 
        limit: int = 5,
        filter_module: Optional[str] = None
    ) -> List[DocumentChunk]:
        """
        Find relevant document chunks from Qdrant via semantic search.
        
        Args:
            query: Search query (will be embedded)
            limit: Maximum number of chunks to return
            filter_module: Optional filter by syllabus module
            
        Returns:
            List of matching DocumentChunk objects
        """
        if not self.qdrant_client:
            logger.warning("Qdrant client not configured")
            return []
        
        try:
            # Build filter if module specified
            filter_dict = None
            if filter_module:
                filter_dict = {
                    "must": [
                        {"key": "syllabus_module", "match": {"value": filter_module}}
                    ]
                }
            
            # Note: In production, you'd embed the query first
            # This is a placeholder showing the structure
            results = self.qdrant_client.search(
                collection_name=self.collection_name,
                query_vector=[0.0] * 384,  # Placeholder - use actual embedding
                limit=limit,
                query_filter=filter_dict
            )
            
            chunks = []
            for hit in results:
                payload = hit.payload or {}
                chunks.append(DocumentChunk(
                    chunk_id=str(hit.id),
                    content=payload.get("text", ""),
                    source_file=payload.get("source_file", "Unknown"),
                    page_number=payload.get("page_number", 0),
                    score=hit.score,
                    syllabus_module=payload.get("syllabus_module"),
                    syllabus_topic=payload.get("syllabus_topic")
                ))
            
            return chunks
            
        except Exception as e:
            logger.error(f"Error querying Qdrant: {e}")
            return []
    
    async def get_enhanced_context(
        self, 
        query: str,
        max_topics: int = 3,
        max_chunks: int = 5
    ) -> EnhancedContext:
        """
        Get enhanced context by combining Neo4j curriculum and Qdrant chunks.
        
        This is the main entry point for RAG enhancement.
        
        Args:
            query: User's question
            max_topics: Maximum curriculum topics to retrieve
            max_chunks: Maximum document chunks to retrieve
            
        Returns:
            EnhancedContext with combined information
        """
        # 1. Get curriculum topics from Neo4j
        topics = await self.get_curriculum_topics(query, limit=max_topics)
        
        # 2. Get document chunks from Qdrant
        chunks = await self.get_document_chunks(query, limit=max_chunks)
        
        # 3. Build prerequisite chain from matched topics
        prerequisite_chain = []
        for topic in topics:
            prerequisite_chain.extend(topic.prerequisites)
        prerequisite_chain = list(set(prerequisite_chain))  # Deduplicate
        
        # 4. Find related topics
        related = set()
        for chunk in chunks:
            if chunk.syllabus_topic:
                related.add(chunk.syllabus_topic)
        for topic in topics:
            related.update(topic.subtopics[:3])  # Top 3 subtopics
        
        return EnhancedContext(
            query=query,
            curriculum_context=topics,
            document_chunks=chunks,
            related_topics=list(related),
            prerequisite_chain=prerequisite_chain
        )
    
    def format_context_for_prompt(self, context: EnhancedContext) -> str:
        """
        Format enhanced context into a string for LLM prompts.
        
        Args:
            context: EnhancedContext object
            
        Returns:
            Formatted string for prompt injection
        """
        parts = []
        
        # Curriculum context
        if context.curriculum_context:
            parts.append("📚 CURRICULUM CONTEXT:")
            for topic in context.curriculum_context:
                parts.append(f"  • {topic.module} → {topic.name}")
                if topic.prerequisites:
                    parts.append(f"    Prerequisites: {', '.join(topic.prerequisites)}")
        
        # Document knowledge
        if context.document_chunks:
            parts.append("\n📄 RELEVANT KNOWLEDGE:")
            for chunk in context.document_chunks[:3]:  # Top 3 chunks
                source_info = f"[{chunk.source_file} p.{chunk.page_number}]"
                parts.append(f"  {source_info}")
                # Truncate content for prompt
                content_preview = chunk.content[:200] + "..." if len(chunk.content) > 200 else chunk.content
                parts.append(f"  {content_preview}")
        
        # Prerequisites to mention
        if context.prerequisite_chain:
            parts.append(f"\n⚠️ Student should know: {', '.join(context.prerequisite_chain[:5])}")
        
        return "\n".join(parts)


# Factory function
def create_knowledge_bridge() -> KnowledgeLayerBridge:
    """
    Create a KnowledgeLayerBridge with connections from environment.
    
    Environment variables:
        - NEO4J_URI: Neo4j connection URI
        - NEO4J_USER: Neo4j username  
        - NEO4J_PASSWORD: Neo4j password
        - QDRANT_HOST: Qdrant host
        - QDRANT_PORT: Qdrant port
    """
    neo4j_driver = None
    qdrant_client = None
    
    # Try to connect to Neo4j
    neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:2002")
    neo4j_user = os.getenv("NEO4J_USER", "neo4j")
    neo4j_password = os.getenv("NEO4J_PASSWORD", "password")
    
    try:
        from neo4j import GraphDatabase
        neo4j_driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
        logger.info(f"Connected to Neo4j at {neo4j_uri}")
    except Exception as e:
        logger.warning(f"Could not connect to Neo4j: {e}")
    
    # Try to connect to Qdrant
    qdrant_host = os.getenv("QDRANT_HOST", "localhost")
    qdrant_port = int(os.getenv("QDRANT_PORT", "6335"))
    
    try:
        from qdrant_client import QdrantClient
        qdrant_client = QdrantClient(host=qdrant_host, port=qdrant_port)
        logger.info(f"Connected to Qdrant at {qdrant_host}:{qdrant_port}")
    except Exception as e:
        logger.warning(f"Could not connect to Qdrant: {e}")
    
    return KnowledgeLayerBridge(
        neo4j_driver=neo4j_driver,
        qdrant_client=qdrant_client
    )


# Example usage
if __name__ == "__main__":
    import asyncio
    
    async def main():
        bridge = create_knowledge_bridge()
        
        # Example query
        context = await bridge.get_enhanced_context("What is neural network?")
        
        print("=== Enhanced Context ===")
        print(f"Query: {context.query}")
        print(f"Topics found: {len(context.curriculum_context)}")
        print(f"Chunks found: {len(context.document_chunks)}")
        print(f"Prerequisites: {context.prerequisite_chain}")
        print(f"\nFormatted for prompt:")
        print(bridge.format_context_for_prompt(context))
    
    asyncio.run(main())
