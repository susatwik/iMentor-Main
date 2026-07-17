#!/usr/bin/env python3
"""Parse the AICTE EE B.Tech R24 curriculum PDF into structured JSON."""

import json, re

with open('/Users/susatwikmanuri/Downloads/iMentor-Main/server/scripts/curriculum_pdf.json') as f:
    pages = json.load(f)

full_text = "\n".join(p['text'] for p in pages)

# Strategy: Extract semester tables and individual course syllabi separately
# Then cross-reference

# ── 1. Extract semester tables ──────────────────────────────────────
# Semester table pattern: "I – Year: I – Semester" followed by S.No, Course Code, Title, L, T, P, Credits
semester_pattern = re.compile(
    r'(?:I{1,3}|IV)\s*[–-]+\s*Year\s*[:\s]+(?:I{1,3}|IV)\s*[–-]+\s*Semester.*?(?=\n\n(?:I{1,3}|IV)\s*[–-]+\s*Year|Department of\s+Electrical\s+Engineering\s*$|\Z)',
    re.DOTALL | re.IGNORECASE
)

# Let me try a different approach: find each semester section manually
semester_sections = re.split(r'(I{1,3})\s*[–-]+\s*Year\s*[:\s]+\s*(I{1,3})\s*[–-]+\s*Semester', full_text)
print(f"Found {len(semester_sections)} semester sections (rough)")

# Better: extract course entries from tables
# Pattern: Course Code (like EE1011, CS1031, etc.) followed by title, L-T-P, credits
course_table_pattern = re.compile(
    r'(\d+)\s+([A-Z]{2,4}\d{3,4})\s+(.+?)\s+(\d+)\s*[–-]+\s*(\d+)\s*[–-]+\s*(\d+)\s+(\d+)\s+([A-Z]{3})',
    re.DOTALL
)

# Extract from semester pages (6-13)
semester_pages = [p for p in pages if 6 <= p['page'] <= 13]
semester_text = "\n".join(p['text'] for p in semester_pages)

print("\n--- Semester table raw (first 2000 chars) ---")
print(semester_text[:2000])

# Parse course entries
course_entries = []
for m in course_table_pattern.finditer(semester_text):
    course_entries.append({
        'sno': m.group(1),
        'code': m.group(2),
        'title': ' '.join(m.group(3).split()),
        'l': m.group(4),
        't': m.group(5),
        'p': m.group(6),
        'credits': m.group(7),
        'category': m.group(8),
    })

print(f"\nFound {len(course_entries)} course entries in tables")
for c in course_entries[:10]:
    print(f"  {c['code']}: {c['title'][:60]} ({c['credits']}cr, {c['category']})")
