# Local Interactive CI/CD Runner & Debugger

A local development tool that executes GitHub Actions workflows inside containerized environments, providing step execution, real-time logging, environment inspection, and interactive debugging.

### Features (Work in Progress)
- Detects `.github/workflows` YAML files in any local repository.
- Parses workflows, jobs, and steps.
- Mounts the local repository path into a Docker container (`ubuntu:22.04`).
- Executes step run commands sequentially.
- Streams stdout/stderr logs in real time via WebSockets.
- Automatically cleans up Docker containers on run completion or tab closure.
