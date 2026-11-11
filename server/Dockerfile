FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt requirements-separation.txt ./
ARG WITH_SEPARATION=1
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$WITH_SEPARATION" = "1" ]; then \
      pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
      && pip install --no-cache-dir -r requirements-separation.txt \
      && python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"; \
    fi
COPY app ./app
ENV DATA_DIR=/tmp/pianovision PORT=8000
RUN useradd -m app && mkdir -p /tmp/pianovision && chown app /tmp/pianovision
USER app
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
