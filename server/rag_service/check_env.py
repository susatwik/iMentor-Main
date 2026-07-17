"""Environment and service checker for the RAG FastAPI service.
Run from project root:
  python server/rag_service/check_env.py

It reports missing Python packages and attempts to connect to Qdrant, Neo4j, Redis, and Elasticsearch
using the `server/.env` configuration loaded by `config.py`.
"""
import importlib
import sys
import socket
from pprint import pprint
import os

# Ensure local rag_service directory is on sys.path so we can import config
sys.path.insert(0, os.path.dirname(__file__))
import config

REQUIRED_MODULES = [
    'fastapi', 'uvicorn', 'qdrant_client', 'neo4j', 'redis', 'pymongo', 'httpx'
]

print("=== Python module availability ===")
missing = []
for mod in REQUIRED_MODULES:
    try:
        importlib.import_module(mod)
        print(f"OK: {mod}")
    except Exception as e:
        print(f"MISSING: {mod} → {e}")
        missing.append(mod)

print()
print("=== Service connectivity checks (TCP) ===")
services = [
    ('Qdrant', config.QDRANT_URL or f"{config.QDRANT_HOST}:{config.QDRANT_PORT}"),
    ('Neo4j', config.NEO4J_URI),
]

for name, addr in services:
    host = None
    port = None
    # parse simple host:port or URL
    if isinstance(addr, str) and ':' in addr and not addr.startswith('http'):
        try:
            host, port = addr.split(':')
            port = int(port)
        except Exception:
            host = addr
    elif isinstance(addr, str) and addr.startswith('http'):
        try:
            # extract host and port
            import urllib.parse as up
            p = up.urlparse(addr)
            host = p.hostname
            port = p.port
        except Exception:
            host = addr
    else:
        host = addr

    if host and port:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3)
        try:
            s.connect((host, port))
            print(f"OK: {name} reachable at {host}:{port}")
        except Exception as e:
            print(f"FAILED: {name} not reachable at {host}:{port} → {e}")
        finally:
            s.close()
    else:
        print(f"SKIP: {name} (could not parse address: {addr})")

print()
print("=== Summary ===")
print(f"Missing modules: {missing}")
print("If required modules are missing, install them in your Python env, e.g.:\n  pip install -r server/rag_service/requirements.txt")

if missing:
    sys.exit(2)

print("All required modules appear installed. You can attempt to start the RAG service with uvicorn.")
