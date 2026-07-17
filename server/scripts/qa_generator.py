# server/scripts/qa_generator.py
import json
import argparse
import os

def format_for_finetuning(input_file, output_file):
    """
    Converts a JSON array of Q&A pairs into JSONL format for fine-tuning.
    Expected input format: [{"instruction": "...", "response": "..."}, ...]
    """
    print(f"Reading from {input_file}...")
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        print(f"Processing {len(data)} items...")
        
        with open(output_file, 'w', encoding='utf-8') as f:
            for item in data:
                # Basic validation
                if 'instruction' not in item or 'response' not in item:
                    print(f"Skipping invalid item: {item}")
                    continue
                
                # Format for most SLM fine-tuning libraries (e.g., Unsloth, HuggingFace)
                # You can customize this template as needed
                jsonl_line = {
                    "instruction": item['instruction'],
                    "input": "",
                    "output": item['response']
                }
                f.write(json.dumps(jsonl_line) + '\n')
                
        print(f"Successfully wrote {len(data)} lines to {output_file}")
        
    except Exception as e:
        print(f"Error processing file: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convert JSON Q&A items to JSONL for fine-tuning.")
    parser.add_argument("--input", required=True, help="Path to input JSON file")
    parser.add_argument("--output", required=True, help="Path to output JSONL file")
    
    args = parser.parse_args()
    
    format_for_finetuning(args.input, args.output)
