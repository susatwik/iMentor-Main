# server/rag_service/prompts.py

CODE_ANALYSIS_PROMPT_TEMPLATE = """
You are an expert software engineer and code reviewer. Your task is to provide a comprehensive, professional analysis of the following code snippet.

**Analysis Sections (Use Markdown headings for each):**
1.  **Code Functionality:** Briefly explain what the code does, its main purpose, and its expected inputs and outputs.
2.  **Bug Identification:** Meticulously check for any logical errors, potential runtime errors (e.g., division by zero, index out of bounds), or security vulnerabilities. If you find any, explain the bug clearly. If not, state that no obvious bugs were found.
3.  **Improvements & Suggestions:** Recommend changes to improve the code's clarity, efficiency, and adherence to best practices (e.g., better variable names, more efficient algorithms, error handling).

**Formatting:**
- Use clear Markdown for structure.
- For code suggestions, use fenced code blocks with the correct language identifier.

---
**LANGUAGE:**
{language}
---
**CODE TO ANALYZE:**
{code}
**ANALYSIS REPORT:**
"""

TEST_CASE_GENERATION_PROMPT_TEMPLATE = """
You are a meticulous Quality Assurance (QA) engineer. Your task is to generate a comprehensive set of test cases for the given code.
Instructions:
Analyze the code to understand its logic, inputs, and outputs.
Create a diverse set of test cases that cover:
Standard Cases: Common, expected inputs.
Edge Cases: Boundary values, empty inputs, zeros, negative numbers, etc.
Error Cases: Invalid inputs that should cause the program to handle an error gracefully (if applicable).
Your entire output MUST be a single, valid JSON array of objects.
Each object in the array must have two keys: input (a string) and expectedOutput (a string).
For inputs that require multiple lines, use the newline character \\n.
Example Output Format:
[
{{"input": "5\\n10", "expectedOutput": "15"}},
{{"input": "0\\n0", "expectedOutput": "0"}},
{{"input": "-5\\n5", "expectedOutput": "0"}}
]
LANGUAGE:
{language}
CODE TO ANALYZE:
{code}
FINAL JSON TEST CASE ARRAY:
"""


EXPLAIN_ERROR_PROMPT_TEMPLATE = """
You are an expert programming tutor, specializing in explaining complex errors to beginners. Your task is to explain the following runtime error in a clear, step-by-step manner.
Instructions:
Identify the Root Cause: Analyze the error message in the context of the provided code to determine the exact reason for the error.
Explain the Error: Describe what the error message means in simple terms. Avoid jargon where possible, or explain it if necessary.
Pinpoint the Location: State which line(s) of code are causing the problem.
Provide a Solution: Give a corrected version of the problematic code in a fenced code block and explain why the fix works.
Offer General Advice: Provide a concluding tip to help the user avoid similar errors in the future.
Formatting:
Use clear Markdown headings for each section (e.g., ## What Went Wrong, ## How to Fix It).
Use fenced code blocks for all code snippets.
LANGUAGE:
{language}

CODE WITH THE ERROR:
{code}
ERROR MESSAGE:
{error_message}
ERROR EXPLANATION:
"""


QUIZ_GENERATION_PROMPT_TEMPLATE = """
You are an expert educator and assessment creator. Your task is to generate a multiple-choice quiz based SOLELY on the provided document text.

**CRITICAL INSTRUCTIONS (MUST FOLLOW):**
1.  **Strictly Adhere to Context:** Every question, option, and correct answer MUST be directly derived from the information present in the "DOCUMENT TEXT TO ANALYZE" section. Do NOT use any outside knowledge or make assumptions beyond the text.
2.  **Generate Questions:** Create exactly {num_questions} high-quality multiple-choice questions that test understanding of the main concepts, definitions, and key facts in the text.
3.  **Plausible Distractors:** For each question, provide 4 distinct options. One must be the correct answer from the text. The other three must be plausible but incorrect distractors that are relevant to the topic but not supported by the provided text.
4.  **No Trivial Questions:** Do not ask questions about document metadata, section titles, or insignificant details. Focus on the core material.
5.  **Strict JSON Output:** Your entire output **MUST** be a single, valid JSON array of objects. Do NOT include any introductory text, explanations, or markdown fences like ```json ... ```. Your response must begin with `[` and end with `]`.

**JSON SCHEMA PER QUESTION (STRICT):**
{{
    "question": "The full text of the question.",
    "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
    "correctAnswer": "The exact text of the correct answer, which MUST match one of the four options."
}}

**EXAMPLE OF A GOOD QUESTION (Based on a hypothetical text about photosynthesis):**
{{
    "question": "According to the document, what are the two primary products of photosynthesis?",
    "options": ["Water and Carbon Dioxide", "Glucose and Oxygen", "Sunlight and Chlorophyll", "Nitrogen and Water"],
    "correctAnswer": "Glucose and Oxygen"
}}

---
**DOCUMENT TEXT TO ANALYZE:**
{document_text}
---

**FINAL QUIZ JSON ARRAY (start immediately with `[`):**
"""



# ==============================================================================
# === ACADEMIC INTEGRITY PROMPTS ===
# ==============================================================================

BIAS_CHECK_PROMPT_TEMPLATE = """
You are an expert in academic writing and ethical communication. Your task is to analyze the provided text for any language that could be considered biased, non-inclusive, or contentious.

**INSTRUCTIONS:**
1.  Read the text carefully to identify words or phrases related to gender, race, disability, age, or other sensitive areas.
2.  Look for stereotypes, generalizations, or potentially alienating language.
3.  Your entire output MUST be a single, valid JSON object with one key: "findings".
4.  The "findings" key must hold an array of objects. If no issues are found, the array should be empty.
5.  Each finding object MUST have these keys:
    -   "text": The exact biased phrase found in the text.
    -   "reason": A brief, neutral explanation of why this phrase might be problematic.
    -   "suggestion": A more inclusive or objective alternative.

**EXAMPLE OUTPUT:**
{{
  "findings": [
    {{
      "text": "The forefathers of the nation...",
      "reason": "This term is gender-exclusive and overlooks the contributions of women.",
      "suggestion": "The founders of the nation..."
    }},
    {{
      "text": "A blind review process...",
      "reason": "Using 'blind' in this context can be seen as ableist language.",
      "suggestion": "An anonymized review process..."
    }}
  ]
}}

---
**TEXT TO ANALYZE:**
{text_to_analyze}
---

**FINAL JSON OUTPUT (start immediately with `{{`):**
"""

FACT_CHECK_EXTRACT_PROMPT_TEMPLATE = """
You are a meticulous research assistant. Your task is to read the provided text and extract all distinct, verifiable factual claims.

**INSTRUCTIONS:**
1.  Identify statements that present objective information, such as statistics, historical events, scientific statements, or specific data points.
2.  Ignore subjective opinions, questions, or general statements that cannot be verified.
3.  Your entire output MUST be a single, valid JSON object with one key: "claims".
4.  The "claims" key must hold an array of strings. Each string is a direct quote of a factual claim from the text.
5.  If no verifiable claims are found, the array should be empty.

**EXAMPLE OUTPUT for a text containing "The Earth is the third planet from the Sun, and its population exceeds 8 billion people.":**
{{
  "claims": [
    "The Earth is the third planet from the Sun.",
    "The Earth's population exceeds 8 billion people."
  ]
}}

---
**TEXT TO ANALYZE:**
{text_to_analyze}
---

**FINAL JSON OUTPUT (start immediately with `{{`):**
"""

FACT_CHECK_VERIFY_PROMPT_TEMPLATE = """
You are an impartial fact-checker and synthesizer. You have been given a specific "CLAIM" and a set of "SEARCH RESULTS" from the web and academic sources. Your task is to determine the validity of the claim based ONLY on the provided search results.

**INSTRUCTIONS:**
1.  Carefully compare the "CLAIM" to the information in the "SEARCH RESULTS".
2.  Your entire output MUST be a single, valid JSON object with two keys: "status" and "evidence".
3.  The "status" key must be one of three strings: "Supported", "Refuted", or "Unverified".
    -   "Supported": The search results contain clear evidence that validates the claim.
    -   "Refuted": The search results contain clear evidence that contradicts the claim.
    -   "Unverified": The search results do not contain enough information to either support or refute the claim.
4.  The "evidence" key must be a string containing a brief, neutral summary of the findings from the search results that led to your status decision. This summary MUST cite the sources using bracket notation (e.g., [1], [2]).

---
**CLAIM TO VERIFY:**
{claim}
---
**SEARCH RESULTS (Your ONLY source of information):**
{search_results}
---

**FINAL JSON OUTPUT (start immediately with `{{`):**
"""


# server/rag_service/prompts.py

# (Keep all existing prompts)

# ... at the end of the file ...

# ==============================================================================
# === ON-THE-FLY DOCUMENT GENERATION PROMPTS ===
# ==============================================================================

DOCX_GENERATION_FROM_TOPIC_PROMPT_TEMPLATE = """
You are a professional content creator and subject matter expert. Your task is to generate a comprehensive, multi-page document in Markdown format based entirely on your internal knowledge of the given TOPIC. The content should be informative, well-structured, and suitable for academic or professional readers. The final output must be a single, clean block of Markdown text.

**INSTRUCTIONS:**
1.  **Main Title:** Begin the document with a main title using H1 syntax (e.g., '# An In-Depth Look at {topic}').
2.  **Structured Sections:** Organize the content with meaningful H2 and H3 headings to reflect a clear, logical flow of ideas.
3.  **Content Depth:** Write multi-paragraph sections that demonstrate deep understanding. Where appropriate, include examples, comparisons, or analogies.
4.  **Markdown Formatting:** Use Markdown effectively, including:
    - **Bold** text for key concepts
    - *Italics* for emphasis or terminology
    - - Bullet points or numbered lists for clarity
    - Proper line spacing and readable structure

**QUALITY REQUIREMENTS:**
- Target word count: **1500–3000+ words** across multiple sections
- Ensure the tone is **authoritative**, the structure is **cohesive**, and the information is **accurate and self-contained**

---
**TOPIC:**
{topic}
---

**FINAL DOCUMENT MARKDOWN:**
"""


# ==============================================================================
# === STUDY MODE QUESTION BANK GENERATION PROMPT ===
# ==============================================================================

STUDY_QUESTIONS_GENERATION_PROMPT = """You are an expert curriculum designer and assessment engineer building an adaptive study system.

Course     : {course}
Topic      : {topic_name}
Subtopic   : {subtopic_name}

TEACHING CONTEXT (authoritative source — all questions must align with this material):
<context>
{teaching_context}
</context>

Generate a complete study question bank as VALID JSON ONLY — no prose outside the JSON.

The bank must contain:
  • 15 MCQ with 4 options each (exactly 1 correct, 3 plausible distractors). Mix difficulties: 5 beginner, 6 intermediate, 4 advanced.
  • 3 short-answer questions that require conceptual explanation (not just recall). Mix: 1 beginner, 1 intermediate, 1 advanced.
  • 5 flashcards (key term / concept on front, precise definition or formula on back).

Bloom's taxonomy levels for reference:
  beginner   → remember / understand  (define, list, identify, describe)
  intermediate → apply / analyse       (compare, explain why, apply, differentiate)
  advanced   → evaluate / create       (critique, design, hypothesize, integrate)

JSON SCHEMA (output ONLY this, starting with "{{"):
{{
  "subtopic_id": "{subtopic_id}",
  "subtopic_name": "{subtopic_name}",
  "topic_name": "{topic_name}",
  "course": "{course}",
  "mcq": [
    {{
      "id": "mcq_1",
      "question": "Full question text here.",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_option": "A",
      "explanation": "Why A is correct, referencing the key concept.",
      "difficulty": "beginner",
      "bloom_level": "remember"
    }}
  ],
  "short_answer": [
    {{
      "id": "sa_1",
      "question": "Open-ended question requiring explanation.",
      "model_answer": "Comprehensive model answer covering all key points.",
      "key_concepts": ["concept1", "concept2"],
      "difficulty": "intermediate",
      "bloom_level": "apply"
    }}
  ],
  "flashcards": [
    {{
      "id": "fc_1",
      "front": "Term or concept label.",
      "back": "Precise definition, formula, or explanation.",
      "hint": "Optional mnemonic or memory cue."
    }}
  ]
}}

Rules:
- Every question MUST be grounded in the teaching_context above.
- MCQ distractors must be plausible — not obviously wrong.
- Flashcard backs should be self-contained (student reads only the back to get full understanding).
- mathematical notation uses LaTeX inline ($...$) where relevant.
- Output ONLY the JSON — no markdown fences, no preamble.
"""


# ==============================================================================
# === SKILL TREE / PREREQUISITE GRAPH GENERATION PROMPT ===
# ==============================================================================

SKILL_TREE_GENERATION_PROMPT = """You are an expert curriculum architect analysing a complete course to build a skill dependency graph.

Course: {course}

COMPLETE CURRICULUM (all modules → topics → subtopics with their IDs):
<curriculum>
{curriculum_json}
</curriculum>

Your task: identify which subtopics MUST be understood BEFORE a student can meaningfully learn each other subtopic. This forms the prerequisite graph (skill tree) for adaptive learning paths.

Rules:
1. Prerequisites must be genuinely essential — not merely related or co-located in the syllabus.
2. Avoid ALL circular dependencies.
3. A subtopic can have 0–3 prerequisites (usually ≤ 2).
4. Assign difficulty_score 1–10 (1 = entry level, 10 = most advanced in the course).
5. estimated_study_hours should reflect realistic solo study time (1–8 hours typical).
6. skill_level must be one of: "foundational", "intermediate", "advanced".

Return VALID JSON ONLY starting with "{{":
{{
  "course": "{course}",
  "generated_at": "{timestamp}",
  "skill_tree": [
    {{
      "subtopic_id": "sub_001",
      "subtopic_name": "Name of the subtopic",
      "topic_id": "top_001",
      "topic_name": "Parent topic name",
      "module_id": "mod_001",
      "module_name": "Parent module name",
      "difficulty_score": 2,
      "skill_level": "foundational",
      "estimated_study_hours": 2,
      "prerequisites": [],
      "unlocks": ["sub_002", "sub_003"],
      "learning_outcomes": [
        "Student will be able to ...",
        "Student will understand ..."
      ]
    }}
  ]
}}

Output ONLY the JSON — no markdown fences, no preamble.
"""


CHUNKED_SKILL_TREE_PROMPT = """You are an expert curriculum architect analyzing a PORTION of a course to build part of a skill dependency graph.

Course: {course}
Chunk: {chunk_info}

CURRICULUM SUBSET (modules → topics → subtopics for this chunk only):
<curriculum>
{curriculum_json}
</curriculum>

Your task: identify which subtopics in the list above MUST be understood BEFORE a student can learn each other subtopic. Generate skill tree nodes ONLY for the subtopics listed above.

Rules:
1. Prerequisites must be genuinely essential — not merely related or co-located in the syllabus.
2. A subtopic can have 0–3 prerequisites (usually ≤ 2).
3. Assign difficulty_score 1–10 (1 = entry level, 10 = most advanced).
4. estimated_study_hours should reflect realistic solo study time (1–8 hours typical).
5. skill_level must be one of: "foundational", "intermediate", "advanced".
6. If a prerequisite belongs to a DIFFERENT module than the subtopic, include it anyway — cross-module edges are critical.
7. Only generate nodes for subtopics explicitly listed in the curriculum above.

Return VALID JSON ONLY starting with "{{":
{{
  "course": "{course}",
  "generated_at": "{timestamp}",
  "skill_tree": [
    {{
      "subtopic_id": "sub_001",
      "subtopic_name": "Name of the subtopic",
      "topic_id": "top_001",
      "topic_name": "Parent topic name",
      "module_id": "mod_001",
      "module_name": "Parent module name",
      "difficulty_score": 2,
      "skill_level": "foundational",
      "estimated_study_hours": 2,
      "prerequisites": [],
      "unlocks": ["sub_002", "sub_003"],
      "learning_outcomes": [
        "Student will be able to ...",
        "Student will understand ..."
      ]
    }}
  ]
}}

Output ONLY the JSON — no markdown fences, no preamble.
"""


CROSS_CHUNK_LINKING_PROMPT = """You are an expert curriculum architect. Given ALL subtopics across all modules of the {course} course, identify CROSS-MODULE prerequisite relationships only.

CRITICAL RULE: Only identify prerequisites where the prerequisite subtopic is in a DIFFERENT module than the subtopic it is a prerequisite for. Do NOT repeat within-module prerequisites.

For each subtopic, if it has prerequisites from earlier/other modules, list those prerequisite subtopic IDs.

Here is the complete list of subtopics grouped by module:

{cross_module_json}

Return ONLY a JSON object with this structure (no markdown fences, no preamble):
{{
  "cross_module_edges": {{
    "subtopic_id_that_has_prerequisites": ["prereq_sub_id_1", "prereq_sub_id_2"],
    ...
  }}
}}

If there are NO cross-module prerequisite edges found, return:
{{"cross_module_edges": {{}}}}
"""


PPTX_GENERATION_FROM_TOPIC_PROMPT_TEMPLATE = """
You are a professional presentation designer and subject matter expert. Your task is to create a well-structured and visually engaging 6–8 slide presentation on the given TOPIC using your internal knowledge. The output must be a single, valid JSON array. Each object in the array represents a slide.

Each slide must follow this format:
{
    "slide_title": "A short and relevant title for the slide.",
    "slide_content": "Slide content written using Markdown formatting. Use **bold**, *italics*, - bullet points, and short paragraphs as needed. Ensure clarity and readability.",
    "image_prompt": "A descriptive and creative prompt for an AI image generator. Mention the subject, style, mood, and layout of the image to match the slide content."
}

Instructions:
use font of 12pt and each slide contains 5 bullet points
1. Generate 6 to 8 slides that flow logically from introduction to conclusion.
2. Ensure each slide focuses on a single idea or subtopic.
3. Provide informative, presentation-ready content in each slide.
4. Write a unique and well-matched image_prompt for every slide.
5. Return only the final output: a clean, valid JSON array with no extra text.

---
TOPIC:
{topic}
---

FINAL PRESENTATION JSON ARRAY:
"""

FINE_TUNING_QA_GENERATION_PROMPT_TEMPLATE = """
You are an expert Curriculum Engineer and Knowledge Scientist. Your task is to extract high-quality, granular Question-Answer pairs from the provided text to be used for fine-tuning an AI Tutor.

**CRITICAL INSTRUCTIONS:**
1.  **Granularity:** Focus on specific concepts, definitions, processes, and relationships found in the text.
2.  **Accuracy:** Every answer MUST be directly supported by the "DOCUMENT TEXT". Do not hallucinate.
3.  **Tone:** The 'instruction' should be a natural student question, and the 'output' should be a clear, pedagogical response from a tutor.
4.  **Quantity:** Generate exactly {num_pairs} pairs for this block of text.
5.  **Difficulty Tagging (REQUIRED):** Assign a difficulty level to EACH pair using Bloom's Taxonomy as a guide:
    - "beginner" — Recall & basic understanding (define, list, identify, describe)
    - "intermediate" — Application & analysis (compare, explain why, apply, differentiate)
    - "advanced" — Evaluation & synthesis (evaluate, design, critique, hypothesize, integrate)
    Mix difficulty levels across your pairs: aim for ~40% beginner, ~40% intermediate, ~20% advanced.
6.  **Subject Taxonomy (REQUIRED):** For each pair, classify the subject area and specific topic:
    - "subject" — The broad academic discipline (e.g., "Machine Learning", "Data Structures", "Physics", "Biology")
    - "topic" — The specific concept or subtopic within that subject (e.g., "Gradient Descent", "Binary Trees", "Newton's Laws")
7.  **Strict JSON Output:** Your entire output **MUST** be a single, valid JSON array of objects. Do NOT include any introductory text or markdown fences.

**JSON SCHEMA PER PAIR (STRICT):**
{{
    "instruction": "A student-like question about a specific concept in the text.",
    "output": "A detailed, accurate, and helpful pedagogical explanation.",
    "difficulty": "beginner | intermediate | advanced",
    "subject": "The broad academic discipline this QA belongs to.",
    "topic": "The specific concept or subtopic covered by this QA."
}}

**EXAMPLE (for a text about neural networks):**
[
  {{
    "instruction": "What is an activation function in a neural network?",
    "output": "An activation function is a mathematical function applied to the output of each neuron. It introduces non-linearity into the network, allowing it to learn complex patterns beyond simple linear relationships. Common examples include ReLU, sigmoid, and tanh.",
    "difficulty": "beginner",
    "subject": "Deep Learning",
    "topic": "Activation Functions"
  }},
  {{
    "instruction": "Why does the vanishing gradient problem occur, and how do ReLU activations help mitigate it?",
    "output": "The vanishing gradient problem occurs when gradients become extremely small during backpropagation through many layers, especially with sigmoid or tanh activations whose derivatives are less than 1. This causes early layers to learn very slowly. ReLU (Rectified Linear Unit) mitigates this because its derivative is either 0 or 1, so gradients don't shrink when the neuron is active, allowing deeper networks to train effectively.",
    "difficulty": "advanced",
    "subject": "Deep Learning",
    "topic": "Vanishing Gradient Problem"
  }}
]

---
**DOCUMENT TEXT:**
{text}
---

**FINAL QA JSON ARRAY (start immediately with `[`):**
"""

