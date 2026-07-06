// State variables
let activeRepoPath = '';
let selectedWorkflowFile = '';
let selectedJob = null;
let ws = null;
let stepLogs = {};
let combinedLogs = '';
let activeFilterStepId = null;

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
          jobItem.addEventListener('click', () => selectJob(wf.filename, job, jobItem));
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

    const badge = document.createElement('span');
    badge.className = 'step-badge badge-pending';
    badge.id = `step-badge-${step.id}`;

    const name = document.createElement('span');
    name.className = 'step-name';
    name.textContent = step.name;

    const durationSpan = document.createElement('span');
    durationSpan.className = 'step-duration';
    durationSpan.id = `step-duration-${step.id}`;

    li.appendChild(badge);
    li.appendChild(name);
    li.appendChild(durationSpan);
    stepsList.appendChild(li);
  });

  // Reset logs view
  stepLogs = {};
  combinedLogs = '';
  activeFilterStepId = null;
  logFilterLabel.textContent = 'All Steps';
  logsTerminal.textContent = 'Ready to execute. Click Run Job above.';
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
  
  updateLogsView();
}

showAllLogsBtn.addEventListener('click', () => {
  activeFilterStepId = null;
  logFilterLabel.textContent = 'All Steps';
  document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active-step'));
  updateLogsView();
});

// Trigger job execution via WebSockets
runJobBtn.addEventListener('click', () => {
  if (!selectedJob || !selectedWorkflowFile) return;

  // Reset steps status and durations in UI
  selectedJob.steps.forEach(step => {
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
  activeFilterStepId = null;
  updateLogsView();

  runJobBtn.setAttribute('disabled', 'true');
  repoPathInput.setAttribute('disabled', 'true');
  loadWorkflowsBtn.setAttribute('disabled', 'true');

  // Determine WebSocket protocol (ws or wss)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    combinedLogs += 'Connected. Initializing run...\n';
    updateLogsView();
    ws.send(JSON.stringify({
      type: 'run_job',
      workflowFile: selectedWorkflowFile,
      jobId: selectedJob.id
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
    logsTerminal.textContent += `\n[WebSocket Error] Connection issue.`;
    cleanupRun();
  };

  ws.onclose = () => {
    logsTerminal.textContent += `\n[WebSocket] Connection closed.`;
    cleanupRun();
  };
});

function cleanupRun() {
  runJobBtn.removeAttribute('disabled');
  repoPathInput.removeAttribute('disabled');
  loadWorkflowsBtn.removeAttribute('disabled');
  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}
