FROM docker.io/library/python:3.13-slim

WORKDIR /app

# Create non-root user for security
RUN useradd -m -u 1000 jarvis

# Copy requirements first for better caching
COPY requirements.txt /app/requirements.txt

# Install Python dependencies
RUN if [ -f /app/requirements.txt ]; then \
    pip install --no-cache-dir -r /app/requirements.txt; \
    fi

# server.py is bind-mounted over this at runtime (compose.yaml) so code
# updates need only a container restart, not a rebuild. COPY is fallback.
COPY server.py /app/server.py
COPY test_server.py /app/test_server.py

# Set ownership of /app directory
RUN chown -R jarvis:jarvis /app

# scripts/, host-scripts/, .token and data/ are bind-mounted at runtime.
# Runs as container root -> host user kim under rootless Podman.
EXPOSE 8790 8791

# Switch to non-root user
USER jarvis

CMD ["python", "-u", "server.py"]
