FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app
RUN pip install --no-cache-dir uv==0.12.22
COPY pyproject.toml uv.lock ./
COPY gomoku ./gomoku
RUN uv sync --frozen --no-dev --no-editable
RUN useradd --create-home --uid 10001 gomoku
USER gomoku

EXPOSE 8000
CMD ["/app/.venv/bin/python", "-m", "gomoku"]
