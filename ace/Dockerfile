FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY ace /app/ace

EXPOSE 8000

ENTRYPOINT ["python", "-m", "ace.server"]
CMD ["--host", "0.0.0.0", "--port", "8000"]
