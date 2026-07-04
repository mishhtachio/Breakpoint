# Local Interactive CI/CD Runner & Debugger

A local development tool that executes GitHub Actions workflows inside containerized environments, providing step execution, real-time logging, environment inspection, and interactive debugging.

## Phase 1 — Local Workflow Runner (MVP)

The current MVP executes GitHub Actions jobs locally inside a Docker container while streaming execution status and logs in real time to a simple browser interface.

### Features
- Detects `.github/workflows` YAML files in any local repository.
- Parses workflows, jobs, and steps.
- Mounts the local repository path into a Docker container (`ubuntu:22.04`).
- Executes step run commands sequentially.
- Streams stdout/stderr logs in real time via WebSockets.
- Automatically cleans up Docker containers on run completion or tab closure.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (must be running)

### Installation
1. Clone or download the repository.
2. In the project root directory, run:
   ```bash
   npm install
   ```

### Running the Application
1. Start the backend Express server:
   ```bash
   npm start
   ```
2. Open your web browser and navigate to:
   ```
   http://localhost:3000
   ```
3. Enter the absolute path to your local repository containing a `.github/workflows` folder, then click **Load Workflows**.
4. Select a job and click **Run Job**.
