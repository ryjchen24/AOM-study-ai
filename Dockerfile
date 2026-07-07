FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates openssl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY frontend/ frontend/
RUN cd frontend && npm install && npm run build

COPY backend/ backend/
RUN cd backend && prisma generate

WORKDIR /app/backend

CMD prisma migrate deploy && uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
