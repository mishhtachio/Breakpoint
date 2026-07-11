// State variables
let activeRepoPath = '';
let selectedWorkflowFile = '';
let selectedJob = null;
let ws = null;
let stepLogs = {};
let combinedLogs = '';
let activeFilterStepId = null;
let activeBreakpoints = new Set();

// UI Elements
const repoPathInput = document.getElementById('repoPathInput');
const loadWorkflowsBtn = document.getElementById('loadWorkflowsBtn');
const statusMessage = document.getElementById('statusMessage');
const workflowList = document.getElementById('workflowList');
const activeJobTitle = document.getElementById('activeJobTitle');
const runJobBtn = document.getElementById('runJobBtn');
const stepsList = document.getElementById('stepsList');
const logsTerminal = document.getElementById('logsTerminal');
const logFilterLabel = document.getElementById('logFilterLabel');
const showAllLogsBtn = document.getElementById('showAllLogsBtn');
const runStepBtn = document.getElementById('runStepBtn');
const runUntilBtn = document.getElementById('runUntilBtn');
const runFromBtn = document.getElementById('runFromBtn');
const continueBtn = document.getElementById('continueBtn');
const terminalInputWrapper = document.getElementById('terminalInputWrapper');
const terminalInput = document.getElementById('terminalInput');

// Initial setup
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.repoPath) {
      activeRepoPath = data.repoPath;
      repoPathInput.value = activeRepoPath;
      statusMessage.textContent = `Active Repository: ${activeRepoPath}`;
      loadWorkflows();
    }
  } catch (err) {
    console.error('Failed to load initial configuration', err);
  }
});

// Load button event listener
loadWorkflowsBtn.addEventListener('click', async () => {
  const pathVal = repoPathInput.value.trim();
  if (!pathVal) {
    alert('Please enter a repository path');
    return;
  }

  try {
    statusMessage.textContent = 'Saving configuration...';
    const configRes = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: pathVal })
    });

    const configData = await configRes.json();
    if (configRes.status !== 200) {
      statusMessage.textContent = `Error: ${configData.error}`;
      return;
    }

    activeRepoPath = configData.repoPath;
    statusMessage.textContent = `Active Repository: ${activeRepoPath}`;
    loadWorkflows();
  } catch (err) {
    statusMessage.textContent = 'Error contacting backend';
    console.error(err);
  }
});

// Fetch workflows and display them
async function loadWorkflows() {
  try {
    const res = await fetch('/api/workflows');
    const data = await res.json();

    if (res.status !== 200) {
      workflowList.innerHTML = `<p class="placeholder-text" style="color: #f38ba8;">Error: ${data.error}</p>`;
      return;
    }

    if (!data.workflows || data.workflows.length === 0) {
      workflowList.innerHTML = `<p class="placeholder-text">No workflows found. Make sure .github/workflows exists.</p>`;
      return;
    }

    workflowList.innerHTML = '';
    data.workflows.forEach(wf => {
      const wfItem = document.createElement('div');
      wfItem.className = 'workflow-item';

      const title = document.createElement('div');
      title.className = 'workflow-filename';
      title.textContent = `${wf.name} (${wf.filename})`;
      wfItem.appendChild(title);

      if (wf.error) {
        const errDiv = document.createElement('div');
        errDiv.style.color = '#f38ba8';
        errDiv.style.fontSize = '12px';
        errDiv.textContent = `YAML Error: ${wf.error}`;
        wfItem.appendChild(errDiv);
      } else {
        wf.jobs.forEach(job => {
          const jobItem = document.createElement('div');
          jobItem.className = 'job-item';
          jobItem.textContent = job.name || job.id;
          jobItem.addEventListener('click', () => {
            if (ws !== null) return; // Prevent changing jobs during active run
            selectJob(wf.filename, job, jobItem);
          });
          wfItem.appendChild(jobItem);
        });
      }

      workflowList.appendChild(wfItem);
    });
  } catch (err) {
    workflowList.innerHTML = `<p class="placeholder-text" style="color: #f38ba8;">Failed to load workflows.</p>`;
    console.error(err);
  }
}

// Select a job to display in the main panel
function selectJob(filename, job, jobElement) {
  selectedWorkflowFile = filename;
  selectedJob = job;

  // Visual selection in list
  document.querySelectorAll('.job-item').forEach(el => el.classList.remove('selected'));
  jobElement.classList.add('selected');

  // Update UI headers
  activeJobTitle.textContent = job.name || job.id;
  runJobBtn.removeAttribute('disabled');

  // Load steps into list
  stepsList.innerHTML = '';
  job.steps.forEach(step => {
    const li = document.createElement('li');
    li.className = 'step-item';
    li.id = `step-node-${step.id}`;
    li.addEventListener('click', () => filterLogsByStep(step.id, step.name));

    // Breakpoint Indicator
    const bpIndicator = document.createElement('span');
    bpIndicator.className = 'breakpoint-indicator';
    bpIndicator.id = `step-bp-${step.id}`;
    if (activeBreakpoints.has(step.id)) {
      bpIndicator.classList.add('has-breakpoint');
    }
    bpIndicator.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBreakpoint(step.id);
    });

    const badge = document.createElement('span');
    badge.className = 'step-badge badge-pending';
    badge.id = `step-badge-${step.id}`;

    const name = document.createElement('span');
    name.className = 'step-name';
    name.textContent = step.name;

    const durationSpan = document.createElement('span');
    durationSpan.className = 'step-duration';
    durationSpan.id = `step-duration-${step.id}`;

    li.appendChild(bpIndicator);
    li.appendChild(badge);
    li.appendChild(name);
    li.appendChild(durationSpan);
    stepsList.appendChild(li);
  });

  // Reset logs view and breakpoints
  stepLogs = {};
  combinedLogs = '';
  activeFilterStepId = null;
  logFilterLabel.textContent = 'All Steps';
  activeBreakpoints.clear();
  
  // Disable scoped run buttons
  runStepBtn.setAttribute('disabled', 'true');
  runUntilBtn.setAttribute('disabled', 'true');
  runFromBtn.setAttribute('disabled', 'true');
  
  logsTerminal.textContent = 'Ready to execute. Click Run Job above.';
}

function toggleBreakpoint(stepId) {
  const el = document.getElementById(`step-bp-${stepId}`);
  if (activeBreakpoints.has(stepId)) {
    activeBreakpoints.delete(stepId);
    if (el) el.classList.remove('has-breakpoint');
  } else {
    activeBreakpoints.add(stepId);
    if (el) el.classList.add('has-breakpoint');
  }
}

// Helper: update terminal text content based on current log filters
function updateLogsView(incomingStepId = null) {
  if (activeFilterStepId === null) {
    logsTerminal.textContent = combinedLogs;
    logsTerminal.scrollTop = logsTerminal.scrollHeight;
  } else if (incomingStepId === activeFilterStepId || incomingStepId === null) {
    logsTerminal.textContent = stepLogs[activeFilterStepId] || 'No logs for this step yet.';
    logsTerminal.scrollTop = logsTerminal.scrollHeight;
  }
}

function filterLogsByStep(stepId, stepName) {
  activeFilterStepId = stepId;
  logFilterLabel.textContent = stepName;
  
  document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active-step'));
  const activeLi = document.getElementById(`step-node-${stepId}`);
  if (activeLi) {
    activeLi.classList.add('active-step');
  }

  // Enable step execution buttons
  if (ws === null) {
    runStepBtn.removeAttribute('disabled');
    runUntilBtn.removeAttribute('disabled');
    runFromBtn.removeAttribute('disabled');
  }
  
  updateLogsView();
}

showAllLogsBtn.addEventListener('click', () => {
  activeFilterStepId = null;
  logFilterLabel.textContent = 'All Steps';
  document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active-step'));
  
  // Disable step buttons since no step is selected
  runStepBtn.setAttribute('disabled', 'true');
  runUntilBtn.setAttribute('disabled', 'true');
  runFromBtn.setAttribute('disabled', 'true');
  
  updateLogsView();
});

// Trigger scoped or standard job execution
function startJobExecution(runMode = 'all') {
  if (!selectedJob || !selectedWorkflowFile) return;

  const targetStepId = activeFilterStepId;
  let targetSteps = selectedJob.steps;

  // Filter which steps will run to reset their visual status
  if (runMode && targetStepId) {
    const idx = selectedJob.steps.findIndex(s => s.id === targetStepId);
    if (idx !== -1) {
      if (runMode === 'step') {
        targetSteps = [selectedJob.steps[idx]];
      } else if (runMode === 'until') {
        targetSteps = selectedJob.steps.slice(0, idx + 1);
      } else if (runMode === 'from') {
        targetSteps = selectedJob.steps.slice(idx);
      }
    }
  }

  // Reset steps status and durations in UI for steps that will be run
  targetSteps.forEach(step => {
    const badge = document.getElementById(`step-badge-${step.id}`);
    if (badge) {
      badge.className = 'step-badge badge-pending';
    }
    const durationSpan = document.getElementById(`step-duration-${step.id}`);
    if (durationSpan) {
      durationSpan.textContent = '';
    }
  });

  // Clear logs state
  stepLogs = {};
  combinedLogs = 'Connecting to runner...\n';
  updateLogsView();

  // Disable UI controls
  runJobBtn.setAttribute('disabled', 'true');
  runStepBtn.setAttribute('disabled', 'true');
  runUntilBtn.setAttribute('disabled', 'true');
  runFromBtn.setAttribute('disabled', 'true');
  repoPathInput.setAttribute('disabled', 'true');
  loadWorkflowsBtn.setAttribute('disabled', 'true');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    combinedLogs += 'Connected. Initializing run...\n';
    updateLogsView();
    ws.send(JSON.stringify({
      type: 'run_job',
      workflowFile: selectedWorkflowFile,
      jobId: selectedJob.id,
      runMode: runMode,
      targetStepId: targetStepId,
      breakpoints: Array.from(activeBreakpoints)
    }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'job_start':
          combinedLogs += `[LocalRunner] Starting job: ${msg.jobId}\n`;
          stepLogs['setup'] = `[LocalRunner] Starting job: ${msg.jobId}\n`;
          updateLogsView();
          break;

        case 'step_start':
          stepLogs[msg.stepId] = '';
          const startBadge = document.getElementById(`step-badge-${msg.stepId}`);
          if (startBadge) {
            startBadge.className = 'step-badge badge-running';
          }
          break;

        case 'step_log':
          const targetId = msg.stepId || 'setup';
          stepLogs[targetId] = (stepLogs[targetId] || '') + msg.data;
          combinedLogs += msg.data;
          updateLogsView(targetId);
          break;

        case 'step_end':
          const endBadge = document.getElementById(`step-badge-${msg.stepId}`);
          if (endBadge) {
            endBadge.className = `step-badge badge-${msg.status}`;
          }
          const durationSpan = document.getElementById(`step-duration-${msg.stepId}`);
          if (durationSpan && msg.duration) {
            durationSpan.textContent = msg.duration;
            if (msg.exitCode !== undefined && msg.exitCode !== 0) {
              durationSpan.textContent += ` (exit: ${msg.exitCode})`;
            }
          }
          break;

        case 'pause':
          combinedLogs += `\n[LocalRunner] Breakpoint hit! Execution paused before step: ${msg.stepId}\n`;
          stepLogs[msg.stepId] = (stepLogs[msg.stepId] || '') + `\n[LocalRunner] Breakpoint hit! Execution paused. Live terminal is active below.\n`;
          updateLogsView();
          
          // Update badge
          const pauseBadge = document.getElementById(`step-badge-${msg.stepId}`);
          if (pauseBadge) {
            pauseBadge.className = 'step-badge badge-running';
          }
          
          // Show debugger UI
          continueBtn.style.display = 'inline-block';
          terminalInputWrapper.style.display = 'flex';
          terminalInput.value = '';
          terminalInput.removeAttribute('disabled');
          terminalInput.focus();
          break;

        case 'cmd_end':
          // Re-enable terminal input when command finishes
          terminalInput.removeAttribute('disabled');
          terminalInput.value = '';
          terminalInput.focus();
          break;

        case 'job_end':
          combinedLogs += `\n[LocalRunner] Job finished with status: ${msg.status.toUpperCase()}\n`;
          stepLogs['cleanup'] = (stepLogs['cleanup'] || '') + `\n[LocalRunner] Job finished with status: ${msg.status.toUpperCase()}\n`;
          updateLogsView();
          cleanupRun();
          break;

        case 'error':
          combinedLogs += `\n[Error] ${msg.message}\n`;
          updateLogsView();
          cleanupRun();
          break;
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };

  ws.onerror = (err) => {
    combinedLogs += `\n[WebSocket Error] Connection issue.`;
    updateLogsView();
    cleanupRun();
  };

  ws.onclose = () => {
    combinedLogs += `\n[WebSocket] Connection closed.`;
    updateLogsView();
    cleanupRun();
  };
}

// Bind event listeners for execution buttons
runJobBtn.addEventListener('click', () => startJobExecution('all'));
runStepBtn.addEventListener('click', () => startJobExecution('step'));
runUntilBtn.addEventListener('click', () => startJobExecution('until'));
runFromBtn.addEventListener('click', () => startJobExecution('from'));

// Debugger event listeners (Phase 4)
continueBtn.addEventListener('click', () => {
  if (ws) {
    ws.send(JSON.stringify({ type: 'resume' }));
    continueBtn.style.display = 'none';
    terminalInputWrapper.style.display = 'none';
  }
});

terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = terminalInput.value.trim();
    if (!cmd) return;

    if (ws && ws.readyState === WebSocket.OPEN) {
      // Echo command locally in logs
      const targetId = activeFilterStepId || 'setup';
      const echoStr = `$ ${cmd}\n`;
      stepLogs[targetId] = (stepLogs[targetId] || '') + echoStr;
      combinedLogs += echoStr;
      updateLogsView(targetId);

      // Disable input while executing
      terminalInput.setAttribute('disabled', 'true');

      // Send command to backend
      ws.send(JSON.stringify({ type: 'exec_cmd', cmd: cmd }));
    }
  }
});

function cleanupRun() {
  runJobBtn.removeAttribute('disabled');
  
  // Re-enable step-level buttons only if a step remains selected
  if (activeFilterStepId) {
    runStepBtn.removeAttribute('disabled');
    runUntilBtn.removeAttribute('disabled');
    runFromBtn.removeAttribute('disabled');
  }
  
  // Hide debugger UI elements
  continueBtn.style.display = 'none';
  terminalInputWrapper.style.display = 'none';
  terminalInput.value = '';
  terminalInput.removeAttribute('disabled');

  repoPathInput.removeAttribute('disabled');
  loadWorkflowsBtn.removeAttribute('disabled');
  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}
