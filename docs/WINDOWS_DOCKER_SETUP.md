# Windows Docker Desktop Setup

For DeckOS to connect to Docker Desktop on Windows:

1. Install Docker Desktop
2. Ensure Docker Desktop is running

If you run the server in an environment that can’t access the Windows Docker named pipe (e.g. inside WSL), configure Docker connectivity via `DOCKER_HOST`.

If you still see "Docker not accessible", check the server logs for more details.
