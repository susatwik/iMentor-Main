# EE Syllabi Pipeline & Startup Configuration Update

This document describes the changes introduced in the `ee-syllabi-generator` branch, the architecture of the new Electrical Engineering (EE) syllabi pipeline, and the test cases/verification steps for the testing team.

---

## 1. Summary of Changes

### A. Dynamic Startup Configuration (`startup.sh`)
* **Before:** `PROJECT_DIR` was hardcoded to `/run/media/komeshbathula/New Volume1/NIT Projects/iMentor-Main`.
* **After:** Updated to determine the project directory dynamically at runtime using bash-native script path resolution:
  ```bash
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ```
  This makes the system environment-agnostic and prevents failures when running on different developer environments or OS paths.

### B. Automated EE Syllabi Generator (`server/scripts/generate_ee_syllabi.py`)
* A Python script designed to output structured `syllabus.csv` files for all **17 Electrical Engineering (EE)** theory courses listed in the curriculum (e.g., `EE1011`, `EE1021`, `EE2011`, etc.).
* Outputs CSVs matching the required database schema headers:
  `Module,Lecture Number,Lecture Topic,Subtopics,Resources`
* Dynamically creates the corresponding directories under `server/course_bootstrap/` along with an empty `materials/` folder for each course to satisfy the course ingestion scanner.

### C. Batch Course Bootstrapper & STN Pipeline (`bootstrap_ee_courses.py`)
* A batch-runner script located in the project root that discovers all EE courses generated under `server/course_bootstrap/`.
* Programmatically invokes the `bootstrap_course` process for each course to:
  1. Ingest the syllabus into **Neo4j** (mapping Module $\rightarrow$ Topic $\rightarrow$ Subtopic).
  2. Extract the course **Concept Graph**.
  3. Build **Qdrant Vector Database Collections**.
  4. Generate and cache **Subtopic Teaching Notes (STN)** in the background using the LLM's base knowledge.

---

## 2. Ingestion Architecture Flow

```mermaid
graph TD
    A[generate_ee_syllabi.py] -->|1. Generate CSVs & Folders| B[server/course_bootstrap/EExxxx/]
    B -->|Syllabus CSV + Materials Dir| C[bootstrap_ee_courses.py]
    C -->|2. Ingest Syllabus| D[(Neo4j Graph Database)]
    C -->|3. Extract Concept Graph & STN| E[RAG Ingestion Engine]
    E -->|4. Index Teaching Notes| F[(Qdrant Vector Database)]
    E -->|5. Precompute Lessons| G[Local cache / lecture_notes]
```

---

## 3. Testing Team Instructions

Please follow the verification steps below to test the dynamic path configuration, syllabus generation, and STN ingestion.

### Phase 1: Verify Startup script
1. Run syntax checks on `startup.sh`:
   ```bash
   bash -n startup.sh
   ```
2. Verify that running `startup.sh` properly activates the Conda environment and starts up Node and Python backends without pointing to a hardcoded path.

### Phase 2: Test Syllabi Generation
1. Clean up any existing `server/course_bootstrap/EE*` folders (if any).
2. Execute the generator script:
   ```bash
   python3 server/scripts/generate_ee_syllabi.py
   ```
3. **Verify Output:**
   * Ensure 17 new folders starting with `EE` are created under `server/course_bootstrap/`.
   * Check that each folder contains:
     * `syllabus.csv` (Verify it has columns: `Module`, `Lecture Number`, `Lecture Topic`, `Subtopics`, `Resources`).
     * `materials/` directory (Verify it is created).

### Phase 3: Test Batch STN Ingestion Pipeline
1. Ensure the Python RAG service is running (default port is `2001`).
2. Run the batch bootstrapper script:
   ```bash
   python3 bootstrap_ee_courses.py
   ```
3. **Verify Neo4j Integration:**
   * Open the Neo4j browser or run a Cypher query to verify that nodes for `EE1011`, `EE1021`, etc. have been created with `Module`, `Topic`, and `Subtopic` relationship linkages.
4. **Verify Qdrant Ingestion:**
   * Check Qdrant collection `stn_notes` to verify that teaching notes have been generated, embedded, and successfully indexed for the respective EE subtopics.
5. **Verify API Endpoints:**
   * Test querying the backend for a specific subtopic STN:
     ```bash
     curl http://localhost:2001/stn/EE1011%20Basic%20Electrical%20Circuits/introduction_to_circuit_elements
     ```
   * Confirm that the RAG service returns cached teaching notes with a `success: true` response.
