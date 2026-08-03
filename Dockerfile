# Gradebook export: Node (Express) + Python (DuckDB/MotherDuck) on Render.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf python3 /usr/bin/python

WORKDIR /app

# Python dependencies (isolated venv; scripts invoked as `python` from Node).
COPY requirements.txt .
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt \
  && /opt/venv/bin/python -c "import duckdb; duckdb.sql('INSTALL motherduck'); print(duckdb.__version__)"
ENV PATH="/opt/venv/bin:${PATH}"

# Node dependencies (production only).
COPY frontend/package.json frontend/package-lock.json ./frontend/
WORKDIR /app/frontend
RUN npm ci --omit=dev

# Application code.
WORKDIR /app
COPY motherduck_client.py \
  warehouse_list.py \
  warehouse_metadata.py \
  warehouse_export_fallback.py \
  populate_gradebook_from_warehouse.py \
  populate_activity_completion.py \
  populate_missed_submissions.py \
  populate_late_submissions.py \
  populate_inactivity_report.py \
  populate_intake_summary.py \
  ./
COPY frontend/ ./frontend/

WORKDIR /app/frontend

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PYTHON_BIN=python3
ENV EXPORT_OUTPUT_DIR=/tmp/gradebook-exports

EXPOSE 3000

CMD ["node", "server.js"]
