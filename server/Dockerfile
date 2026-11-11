FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt requirements-separation.txt ./
ARG WITH_SEPARATION=1
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$WITH_SEPARATION" = "1" ]; then pip install --no-cache-dir -r requirements-separation.txt; fi
# SCNet int8 ONNX (MIT, starrytong/SCNet; ONNX export by audiojs): pinned revision, SHA-256-verified by model.py
COPY app/model.py /tmp/fetch_model.py
RUN if [ "$WITH_SEPARATION" = "1" ]; then python /tmp/fetch_model.py /srv/models/scnet.int8.onnx; fi && rm /tmp/fetch_model.py
COPY app ./app
ENV DATA_DIR=/tmp/pianovision PORT=8000 SCNET_MODEL=/srv/models/scnet.int8.onnx
RUN useradd -m app && mkdir -p /tmp/pianovision && chown app /tmp/pianovision
USER app
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
