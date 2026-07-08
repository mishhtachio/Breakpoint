const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Global state for target repository path
let activeRepoPath = '';

// Track active executions to prevent container leaks
const activeExecutions = new Map(); // ws client -> execution details

// GET active config
app.get('/api/config', (req, res) => {
  res.json({ repoPath: activeRepoPath });
});

// POST active config
app.post('/api/config', (req, res) => {
  const { repoPath } = req.body;
  if (!repoPath) {
    return res.status(400).json({ error: 'Repository path is required' });
  }

  const absolutePath = path.resolve(repoPath);
  if (!fs.existsSync(absolutePath)) {
    return res.status(400).json({ error: 'Directory does not exist' });
  }

  activeRepoPath = absolutePath;
  res.json({ repoPath: activeRepoPath });
});

// GET workflows inside active repository
app.get('/api/workflows', (req, res) => {
  if (!activeRepoPath) {
    return res.status(400).json({ error: 'No active repository selected. Please configure a path first.' });
  }

  const workflowsDir = path.join(activeRepoPath, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    return res.json({ workflows: [] });
  }

  try {
    const files = fs.readdirSync(workflowsDir);
    const workflows = [];

    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        const filePath = path.join(workflowsDir, file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        try {
          const doc = yaml.load(fileContent);
          if (!doc) continue;

          const workflowName = doc.name || file;
          const parsedJobs = [];

          if (doc.jobs) {
            Object.entries(doc.jobs).forEach(([jobId, jobData]) => {
              const jobName = jobData.name || jobId;
              const steps = (jobData.steps || []).map((step, idx) => {
                return {
                  id: step.id || `step-${idx + 1}`,
                  name: step.name || step.run || step.uses || `Step ${idx + 1}`,
                  run: step.run || null,
                  uses: step.uses || null,
                  env: step.env || null
                };
              });

              parsedJobs.push({
                id: jobId,
                name: jobName,
                runsOn: jobData['runs-on'] || 'ubuntu-latest',
                steps: steps
              });
            });
          }

          workflows.push({
            filename: file,
            name: workflowName,
            jobs: parsedJobs
          });
        } catch (parseErr) {
          console.error(`Error parsing YAML file ${file}:`, parseErr.message);
          workflows.push({
            filename: file,
            name: `Error parsing ${file}`,
            error: parseErr.message,
            jobs: []
          });
        }
      }
    }

    res.json({ workflows });
  } catch (err) {
    console.error('Error reading workflows directory:', err);
    res.status(500).json({ error: 'Failed to read workflows directory' });
  }
});

// Helper: Run command inside Docker container and stream output
function runStepCommand(containerName, command, onLog) {
  return new Promise((resolve, reject) => {
    // Spawn docker exec sh -c "command"
    // Use -i to run interactively, which allows streaming stdin/stdout cleanly
    const proc = spawn('docker', ['exec', '-i', containerName, 'sh', '-c', command]);
    
    proc.stdout.on('data', (data) => {
      onLog(data.toString());
    });

    proc.stderr.on('data', (data) => {
      onLog(data.toString());
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`Command exited with code ${code}`);
        error.code = code;
        reject(error);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// Start Express HTTP server
const httpServer = app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

// Attach WebSocket Server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'run_job') {
        const { workflowFile, jobId, runMode, targetStepId, breakpoints } = data;

        if (!activeRepoPath) {
          ws.send(JSON.stringify({ type: 'error', message: 'No repository is configured.' }));
          return;
        }

        // Find the job in workflows
        const workflowsDir = path.join(activeRepoPath, '.github', 'workflows');
        const filePath = path.join(workflowsDir, workflowFile);
        if (!fs.existsSync(filePath)) {
          ws.send(JSON.stringify({ type: 'error', message: `Workflow file ${workflowFile} not found.` }));
          return;
        }

        const fileContent = fs.readFileSync(filePath, 'utf8');
        const doc = yaml.load(fileContent);
        const jobData = doc?.jobs?.[jobId];

        if (!jobData) {
          ws.send(JSON.stringify({ type: 'error', message: `Job ${jobId} not found in ${workflowFile}.` }));
          return;
        }

        // Extract steps
        let steps = (jobData.steps || []).map((step, idx) => ({
          id: step.id || `step-${idx + 1}`,
          name: step.name || step.run || step.uses || `Step ${idx + 1}`,
          run: step.run || null,
          uses: step.uses || null
        }));

        // Filter steps based on runMode (Phase 3 Step Runner)
        if (runMode && targetStepId) {
          const idx = steps.findIndex(s => s.id === targetStepId);
          if (idx !== -1) {
            if (runMode === 'step') {
              steps = [steps[idx]];
            } else if (runMode === 'until') {
              steps = steps.slice(0, idx + 1);
            } else if (runMode === 'from') {
              steps = steps.slice(idx);
            }
          }
        }

        // Docker container setup
        const timestamp = Date.now();
        const containerName = `runner-${jobId}-${timestamp}`;
        const normalizedRepoPath = activeRepoPath.replace(/\\/g, '/');

        // Track execution state
        const executionState = {
          containerName,
          steps,
          currentStepIndex: 0,
          status: 'running',
          breakpoints: breakpoints || [],
          resolveResume: null
        };
        activeExecutions.set(ws, executionState);

        ws.send(JSON.stringify({ type: 'job_start', jobId, containerName }));

        // 1. Start the Docker container
        ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: 'setup', data: `[LocalRunner] Spin up Docker container: ${containerName}\n` }));
        
        exec(`docker run -d --name ${containerName} -v "${normalizedRepoPath}":/workspace -w /workspace -it ubuntu:22.04 sh`, async (err, stdout, stderr) => {
          if (err) {
            console.error('Docker run error:', err);
            ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: 'setup', data: `[Error] Failed to start Docker container: ${stderr || err.message}\n` }));
            ws.send(JSON.stringify({ type: 'job_end', jobId, status: 'failed' }));
            activeExecutions.delete(ws);
            return;
          }

          ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: 'setup', data: `[LocalRunner] Container started successfully. ID: ${stdout.substring(0, 12)}\n` }));

          let jobSuccess = true;

          // 2. Run steps one-by-one
          for (let i = 0; i < steps.length; i++) {
            // Check if connection is still alive and execution not cancelled
            if (!activeExecutions.has(ws)) {
              console.log('Job execution cancelled: Connection closed.');
              jobSuccess = false;
              break;
            }

            const step = steps[i];
            executionState.currentStepId = step.id; // Track currently executing step ID

            // Breakpoint check (Phase 4 Pausing)
            if (executionState.breakpoints.includes(step.id)) {
              ws.send(JSON.stringify({ type: 'pause', stepId: step.id }));
              await new Promise((resolve) => {
                executionState.resolveResume = resolve;
              });
              executionState.resolveResume = null;
            }

            ws.send(JSON.stringify({ type: 'step_start', jobId, stepId: step.id }));

            if (step.uses) {
              // Simulated Step (actions/checkout, etc.)
              ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: step.id, data: `[LocalRunner Info] Simulated action '${step.uses}'. Workspace is already mounted.\n` }));
              ws.send(JSON.stringify({ type: 'step_end', jobId, stepId: step.id, status: 'success', duration: '0.0s', exitCode: 0 }));
              continue;
            }

            if (step.run) {
              const startTime = Date.now();
              try {
                ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: step.id, data: `$ ${step.run}\n` }));
                await runStepCommand(containerName, step.run, (logData) => {
                  ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: step.id, data: logData }));
                });
                const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
                ws.send(JSON.stringify({ type: 'step_end', jobId, stepId: step.id, status: 'success', duration, exitCode: 0 }));
              } catch (stepErr) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
                const exitCode = stepErr.code !== undefined ? stepErr.code : 1;
                ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: step.id, data: `\n[Error] Step failed: ${stepErr.message}\n` }));
                ws.send(JSON.stringify({ type: 'step_end', jobId, stepId: step.id, status: 'failed', duration, exitCode }));
                jobSuccess = false;
                break; // Stop running further steps
              }
            }
          }

          // 3. Finalize and Cleanup
          ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: 'cleanup', data: `[LocalRunner] Cleaning up container ${containerName}...\n` }));
          exec(`docker rm -f ${containerName}`, (cleanupErr) => {
            if (cleanupErr) {
              console.error('Failed to cleanup container:', cleanupErr);
            }
            ws.send(JSON.stringify({ type: 'step_log', jobId, stepId: 'cleanup', data: `[LocalRunner] Cleanup completed.\n` }));
            ws.send(JSON.stringify({ type: 'job_end', jobId, status: jobSuccess ? 'success' : 'failed' }));
            activeExecutions.delete(ws);
          });
        });
      } else if (data.type === 'resume') {
        const execution = activeExecutions.get(ws);
        if (execution && execution.resolveResume) {
          execution.resolveResume();
        }
      } else if (data.type === 'exec_cmd') {
        const execution = activeExecutions.get(ws);
        if (execution && execution.resolveResume) {
          const { cmd } = data;
          const containerName = execution.containerName;
          const targetId = execution.currentStepId || 'debug';
          
          const proc = spawn('docker', ['exec', '-i', containerName, 'sh', '-c', cmd]);
          
          proc.stdout.on('data', (logData) => {
            ws.send(JSON.stringify({ type: 'step_log', jobId: execution.jobId || '', stepId: targetId, data: logData.toString() }));
          });
          
          proc.stderr.on('data', (logData) => {
            ws.send(JSON.stringify({ type: 'step_log', jobId: execution.jobId || '', stepId: targetId, data: logData.toString() }));
          });
          
          proc.on('close', (code) => {
            ws.send(JSON.stringify({ type: 'cmd_end', exitCode: code }));
          });
          
          proc.on('error', (err) => {
            ws.send(JSON.stringify({ type: 'step_log', jobId: execution.jobId || '', stepId: targetId, data: `[Error] ${err.message}\n` }));
            ws.send(JSON.stringify({ type: 'cmd_end', exitCode: 1 }));
          });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Runner is not paused or container is not active.' }));
        }
      }
    } catch (err) {
      console.error('WebSocket message parsing error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to process socket command' }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
    const execution = activeExecutions.get(ws);
    if (execution) {
      console.log(`Cleaning up container ${execution.containerName} for disconnected client.`);
      exec(`docker rm -f ${execution.containerName}`, (cleanupErr) => {
        if (cleanupErr) console.error('Failed container cleanup on close:', cleanupErr);
      });
      activeExecutions.delete(ws);
    }
  });
});
