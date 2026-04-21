// ============================================================
// TIMEKEEPING APP - Main Application Logic
// ============================================================

let currentUser = null;
let currentView = 'dashboard';

// --- Init ---
function initApp() {
  seedData();
  const saved = sessionStorage.getItem('tk_currentUser');
  if (saved) {
    currentUser = JSON.parse(saved);
    showApp();
  } else {
    showLogin();
  }
}

// --- Toast ---
function toast(msg, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// --- Helpers ---
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function genId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }

function getEmpName(empId) {
  const emp = DB.getEmployees().find(e => e.id === empId);
  return emp ? `${emp.firstName} ${emp.lastName}` : empId;
}

function getProjectName(projId) {
  const p = DB.getProjects().find(x => x.id === projId);
  return p ? `${p.number} - ${p.name}` : projId;
}

function getDayName(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}

function getWeekDates(startDate) {
  const d = new Date(startDate + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    dates.push(dd.toISOString().split('T')[0]);
  }
  return dates;
}

function formatDate(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ============================================================
// LOGIN
// ============================================================
function showLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-container">
      <div class="login-box">
        <div class="logo-area"><div class="icon">&#9201;</div></div>
        <h1>Kindred Industrial</h1>
        <p class="subtitle">Timekeeping System</p>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="login-user" placeholder="Enter username" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="login-pass" placeholder="Enter password" />
        </div>
        <div id="login-error" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none;"></div>
        <button class="btn btn-primary btn-block btn-lg" onclick="doLogin()">Sign In</button>
        <p style="margin-top:16px;font-size:12px;color:var(--gray-400);text-align:center;">
          Demo: admin/admin123 &middot; jsmith/pass123 &middot; tkwright/pass123
        </p>
      </div>
    </div>
  `;
  document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}

function doLogin() {
  const u = document.getElementById('login-user').value.trim();
  const p = document.getElementById('login-pass').value;
  const users = DB.getUsers();
  const user = users.find(x => x.username === u && x.password === p);
  if (!user) {
    const err = document.getElementById('login-error');
    err.textContent = 'Invalid username or password';
    err.style.display = 'block';
    return;
  }
  currentUser = user;
  sessionStorage.setItem('tk_currentUser', JSON.stringify(user));
  showApp();
  toast(`Welcome back, ${user.name}`);
}

function logout() {
  currentUser = null;
  sessionStorage.removeItem('tk_currentUser');
  showLogin();
}

// ============================================================
// APP SHELL
// ============================================================
function showApp() {
  const isAdmin = currentUser.role === 'admin';
  const isTimekeeper = currentUser.role === 'timekeeper';
  const isStaff = currentUser.role === 'staff';

  document.getElementById('app').innerHTML = `
    <div class="app-layout">
      <aside class="sidebar">
        <div class="sidebar-header">
          <h2>&#9201; Timekeeping</h2>
          <div class="user-info">${currentUser.name} &middot; ${currentUser.role}</div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-item active" data-view="dashboard" onclick="navigate('dashboard')">
            <span class="icon">&#9632;</span><span>Dashboard</span>
          </div>
          ${isStaff || isAdmin ? `
          <div class="nav-section">Staff</div>
          <div class="nav-item" data-view="staff-timesheet" onclick="navigate('staff-timesheet')">
            <span class="icon">&#128197;</span><span>My Timesheet</span>
          </div>` : ''}
          ${isTimekeeper || isAdmin ? `
          <div class="nav-section">Field</div>
          <div class="nav-item" data-view="field-timesheet" onclick="navigate('field-timesheet')">
            <span class="icon">&#128221;</span><span>Field Timesheets</span>
          </div>
          <div class="nav-item" data-view="weekly-check" onclick="navigate('weekly-check')">
            <span class="icon">&#9989;</span><span>Weekly Check</span>
          </div>` : ''}
          ${isAdmin ? `
          <div class="nav-section">Admin</div>
          <div class="nav-item" data-view="admin-timesheets" onclick="navigate('admin-timesheets')">
            <span class="icon">&#128203;</span><span>Manage Timesheets</span>
          </div>
          <div class="nav-item" data-view="admin-employees" onclick="navigate('admin-employees')">
            <span class="icon">&#128101;</span><span>Employees</span>
          </div>
          <div class="nav-item" data-view="admin-projects" onclick="navigate('admin-projects')">
            <span class="icon">&#128188;</span><span>Projects</span>
          </div>
          <div class="nav-item" data-view="admin-codes" onclick="navigate('admin-codes')">
            <span class="icon">&#128209;</span><span>Codes &amp; Areas</span>
          </div>
          <div class="nav-item" data-view="admin-badge" onclick="navigate('admin-badge')">
            <span class="icon">&#128179;</span><span>Badge System</span>
          </div>
          <div class="nav-section">Reports</div>
          <div class="nav-item" data-view="labor-cost" onclick="navigate('labor-cost')">
            <span class="icon">&#128200;</span><span>Labor Report</span>
          </div>` : ''}
        </nav>
        <div class="sidebar-footer">
          <div class="nav-item" onclick="logout()">
            <span class="icon">&#10140;</span><span>Sign Out</span>
          </div>
        </div>
      </aside>
      <main class="main-content" id="main-content"></main>
    </div>
  `;
  navigate('dashboard');
}

function navigate(view) {
  currentView = view;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const mc = document.getElementById('main-content');
  switch (view) {
    case 'dashboard': renderDashboard(mc); break;
    case 'staff-timesheet': renderStaffTimesheet(mc); break;
    case 'field-timesheet': renderFieldTimesheet(mc); break;
    case 'weekly-check': renderWeeklyCheck(mc); break;
    case 'admin-timesheets': renderAdminTimesheets(mc); break;
    case 'admin-employees': renderAdminEmployees(mc); break;
    case 'admin-projects': renderAdminProjects(mc); break;
    case 'admin-codes': renderAdminCodes(mc); break;
    case 'admin-badge': renderAdminBadge(mc); break;
    case 'labor-cost': renderLaborCostReport(mc); break;
    default: mc.innerHTML = '<h1>Page Not Found</h1>';
  }
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard(mc) {
  const staffTS = DB.getStaffTimesheets();
  const fieldTS = DB.getFieldTimesheets();
  const emps = DB.getEmployees();
  const projs = DB.getProjects();

  const openField = fieldTS.filter(t => t.status === 'open').length;
  const submittedField = fieldTS.filter(t => t.status === 'submitted').length;
  const totalFieldHours = fieldTS.reduce((sum, ts) =>
    sum + ts.crewEntries.reduce((s, c) => s + c.records.reduce((a, r) => a + getRecTotal(r), 0), 0), 0);

  mc.innerHTML = `
    <div class="page-header"><h1>Dashboard</h1></div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Active Employees</div>
        <div class="stat-value">${emps.filter(e => e.active).length}</div>
        <div class="stat-sub">${emps.filter(e => e.type === 'field' && e.active).length} field &middot; ${emps.filter(e => e.type === 'staff' && e.active).length} staff</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Projects</div>
        <div class="stat-value">${projs.filter(p => p.active).length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Open Field Timesheets</div>
        <div class="stat-value">${openField}</div>
        <div class="stat-sub">${submittedField} submitted</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Field Hours Logged</div>
        <div class="stat-value">${totalFieldHours.toFixed(1)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3>Recent Field Timesheets</h3></div>
      <div class="card-body" style="padding:0;">
        <table class="data-table">
          <thead><tr>
            <th>Timesheet #</th><th>Project</th><th>Area</th><th>Date</th><th>Foreman</th><th>Crew</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${fieldTS.slice(0, 10).map(ts => `
              <tr>
                <td><strong>${ts.timesheetNumber}</strong></td>
                <td>${getProjectName(ts.projectId)}</td>
                <td>${ts.areaCode}</td>
                <td>${formatDate(ts.date)}</td>
                <td>${getEmpName(ts.foreman)}</td>
                <td>${ts.crewEntries.length} workers</td>
                <td><span class="badge badge-${ts.status}">${ts.status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================
// STAFF TIMESHEET
// ============================================================
let staffWeekStart = null;
let currentStaffTS = null;

function renderStaffTimesheet(mc) {
  if (!staffWeekStart) {
    const today = new Date();
    const day = today.getDay();
    const mon = new Date(today);
    mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
    staffWeekStart = mon.toISOString().split('T')[0];
  }

  const weekDates = getWeekDates(staffWeekStart);
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const weekEndDate = weekDates[6]; // Sunday

  // Find or create timesheet for this user/week
  let allTS = DB.getStaffTimesheets();
  currentStaffTS = allTS.find(t => t.empId === currentUser.empId && t.weekStarting === staffWeekStart);
  if (!currentStaffTS) {
    currentStaffTS = {
      id: genId('ST'),
      empId: currentUser.empId,
      weekStarting: staffWeekStart,
      status: 'draft',
      lines: [
        { projectId: '', area: '', taskCode: '', fco: '', hours: { mon:{st:0,ot:0}, tue:{st:0,ot:0}, wed:{st:0,ot:0}, thu:{st:0,ot:0}, fri:{st:0,ot:0}, sat:{st:0,ot:0}, sun:{st:0,ot:0} } }
      ]
    };
    allTS.push(currentStaffTS);
    DB.setStaffTimesheets(allTS);
  }

  const projects = DB.getProjects().filter(p => p.active);
  const areas = DB.getAreas();
  const taskCodes = DB.getTaskCodes();
  const fcos = DB.getFCOs();

  mc.innerHTML = `
    <div class="page-header">
      <h1>My Timesheet</h1>
      <div class="actions">
        <button class="btn btn-success" onclick="saveStaffTimesheet()">Save</button>
        <button class="btn btn-primary" onclick="submitStaffTimesheet()">Submit</button>
      </div>
    </div>

    <div class="card">
      <div class="ts-header">
        <div class="field"><label>Employee</label><div class="value">${currentUser.name}</div></div>
        <div class="field">
          <label>W.E. Date</label>
          <div class="value">
            <div class="week-picker">
              <button class="btn btn-sm btn-outline" onclick="changeStaffWeek(-7)">&larr;</button>
              <span style="font-weight:600;font-size:14px;padding:0 8px;">${formatDate(weekEndDate)}</span>
              <input type="date" value="${staffWeekStart}" onchange="staffWeekStart=this.value;navigate('staff-timesheet')" style="max-width:140px;" />
              <button class="btn btn-sm btn-outline" onclick="changeStaffWeek(7)">&rarr;</button>
            </div>
          </div>
        </div>
        <div class="field"><label>Status</label><div class="value"><span class="badge badge-${currentStaffTS.status}">${currentStaffTS.status}</span></div></div>
      </div>

      <div class="card-body" style="padding:0;overflow-x:auto;">
        <table class="data-table" id="staff-table" style="border-collapse:collapse;">
          <thead>
            <tr>
              <th rowspan="2" style="min-width:130px;border-right:1px solid var(--gray-300);background:var(--gray-50);">Project</th>
              <th rowspan="2" style="min-width:90px;border-right:1px solid var(--gray-300);background:var(--gray-50);">Area</th>
              <th rowspan="2" style="min-width:90px;border-right:1px solid var(--gray-300);background:var(--gray-50);">Task Code</th>
              <th rowspan="2" style="min-width:90px;border-right:2px solid var(--gray-400);background:var(--gray-50);">FCO/PCR</th>
              ${dayNames.map((d, i) => {
                const bgColor = i >= 5 ? '#7c3aed' : (i % 2 === 0 ? '#1a56db' : '#1e40af');
                return `<th colspan="2" class="text-center" style="background:${bgColor};color:white;border-left:2px solid #0f3085;border-right:${i === 6 ? '2px solid var(--gray-400)' : 'none'};padding:8px 4px;font-size:12px;line-height:1.3;">
                  ${d.substring(0,3)}<br><span style="font-weight:400;font-size:10px;opacity:0.85;">${formatDate(weekDates[i])}</span>
                </th>`;
              }).join('')}
              <th rowspan="2" class="text-center" style="min-width:60px;background:var(--gray-800);color:white;border-left:2px solid var(--gray-400);">Total</th>
              <th rowspan="2" style="min-width:160px;background:var(--gray-50);border-left:2px solid var(--gray-400);">Comments</th>
              <th rowspan="2" style="width:36px;background:var(--gray-50);"></th>
            </tr>
            <tr>
              ${dayNames.map((_, i) => {
                const bg1 = i >= 5 ? '#ede9fe' : (i % 2 === 0 ? '#dbeafe' : '#c7d8f5');
                return `
                  <th class="text-center" style="background:${bg1};color:var(--primary-dark);border-left:2px solid #0f3085;font-size:11px;font-weight:700;padding:4px 2px;min-width:45px;">ST</th>
                  <th class="text-center" style="background:${bg1};color:var(--primary-dark);font-size:11px;font-weight:700;padding:4px 2px;min-width:45px;border-right:${i === 6 ? '2px solid var(--gray-400)' : 'none'};">OT</th>
                `;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${currentStaffTS.lines.map((line, idx) => renderStaffLine(line, idx, projects, areas, taskCodes, fcos, dayKeys)).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="4" style="border-right:2px solid var(--gray-400);"><strong>Daily Totals</strong></td>
              ${dayKeys.map((dk, i) => {
                const stTotal = currentStaffTS.lines.reduce((s, l) => s + (l.hours[dk]?.st || 0), 0);
                const otTotal = currentStaffTS.lines.reduce((s, l) => s + (l.hours[dk]?.ot || 0), 0);
                const bg = i >= 5 ? '#f5f3ff' : (i % 2 === 0 ? '#f0f5ff' : '#e4ecfa');
                return `<td class="text-center" style="background:${bg};border-left:2px solid var(--gray-300);"><strong>${stTotal}</strong></td><td class="text-center" style="background:${bg};border-right:${i === 6 ? '2px solid var(--gray-400)' : 'none'};"><strong>${otTotal}</strong></td>`;
              }).join('')}
              <td class="text-center" style="border-left:2px solid var(--gray-400);"><strong>${currentStaffTS.lines.reduce((s, l) => s + dayKeys.reduce((a, dk) => a + (l.hours[dk]?.st || 0) + (l.hours[dk]?.ot || 0), 0), 0)}</strong></td>
              <td style="border-left:2px solid var(--gray-400);"></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="card-body" style="border-top:1px solid var(--gray-200);">
        <button class="btn btn-outline" onclick="addStaffLine()">+ Add Line</button>
      </div>
    </div>
  `;
}

function renderStaffLine(line, idx, projects, areas, taskCodes, fcos, dayKeys) {
  const lineTotal = dayKeys.reduce((s, dk) => s + (line.hours[dk]?.st || 0) + (line.hours[dk]?.ot || 0), 0);
  const projAreas = line.projectId ? areas.filter(a => a.projectId === line.projectId) : areas;

  return `<tr data-line="${idx}">
    <td style="border-right:1px solid var(--gray-200);">
      <select onchange="updateStaffField(${idx},'projectId',this.value)" style="max-width:120px;">
        <option value="">Select...</option>
        ${projects.map(p => `<option value="${p.id}" ${line.projectId === p.id ? 'selected' : ''}>${p.number}</option>`).join('')}
      </select>
    </td>
    <td style="border-right:1px solid var(--gray-200);">
      <select onchange="updateStaffField(${idx},'area',this.value)" style="max-width:100px;">
        <option value="">Select...</option>
        ${projAreas.map(a => `<option value="${a.code}" ${line.area === a.code ? 'selected' : ''}>${a.code}</option>`).join('')}
      </select>
    </td>
    <td style="border-right:1px solid var(--gray-200);">
      <select onchange="updateStaffField(${idx},'taskCode',this.value)" style="max-width:100px;">
        <option value="">Select...</option>
        ${taskCodes.map(t => `<option value="${t.code}" ${line.taskCode === t.code ? 'selected' : ''}>${t.code}</option>`).join('')}
      </select>
    </td>
    <td style="border-right:2px solid var(--gray-400);">
      <select onchange="updateStaffField(${idx},'fco',this.value)" style="max-width:100px;">
        <option value="">None</option>
        ${fcos.map(f => `<option value="${f.code}" ${line.fco === f.code ? 'selected' : ''}>${f.code}</option>`).join('')}
      </select>
    </td>
    ${dayKeys.map((dk, i) => {
      const bg = i >= 5 ? '#faf5ff' : (i % 2 === 0 ? '#f8faff' : '#f0f4fb');
      return `
        <td style="background:${bg};border-left:2px solid var(--gray-300);"><input type="number" min="0" max="24" step="0.25" value="${line.hours[dk]?.st || 0}" onchange="updateStaffHours(${idx},'${dk}','st',this.value)" style="width:50px;" /></td>
        <td style="background:${bg};border-right:${i === 6 ? '2px solid var(--gray-400)' : 'none'};"><input type="number" min="0" max="24" step="0.25" value="${line.hours[dk]?.ot || 0}" onchange="updateStaffHours(${idx},'${dk}','ot',this.value)" style="width:50px;" /></td>
      `;
    }).join('')}
    <td class="text-center" style="border-left:2px solid var(--gray-400);"><strong>${lineTotal}</strong></td>
    <td style="border-left:2px solid var(--gray-400);">
      <input type="text" value="${(line.comment || '').replace(/"/g, '&quot;')}" placeholder="Add comment..."
        onchange="updateStaffField(${idx},'comment',this.value)"
        style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--gray-300);border-radius:4px;" />
    </td>
    <td><button class="btn btn-sm btn-danger" onclick="removeStaffLine(${idx})" title="Remove line">&times;</button></td>
  </tr>`;
}

function updateStaffField(idx, field, value) {
  currentStaffTS.lines[idx][field] = value;
}

function updateStaffHours(idx, day, type, value) {
  if (!currentStaffTS.lines[idx].hours[day]) currentStaffTS.lines[idx].hours[day] = {st:0, ot:0};
  currentStaffTS.lines[idx].hours[day][type] = parseFloat(value) || 0;
  // Re-render totals
  navigate('staff-timesheet');
}

function addStaffLine() {
  currentStaffTS.lines.push({
    projectId: '', area: '', taskCode: '', fco: '', comment: '',
    hours: { mon:{st:0,ot:0}, tue:{st:0,ot:0}, wed:{st:0,ot:0}, thu:{st:0,ot:0}, fri:{st:0,ot:0}, sat:{st:0,ot:0}, sun:{st:0,ot:0} }
  });
  navigate('staff-timesheet');
}

function removeStaffLine(idx) {
  if (currentStaffTS.lines.length <= 1) return toast('Must have at least one line', 'error');
  currentStaffTS.lines.splice(idx, 1);
  navigate('staff-timesheet');
}

function saveStaffTimesheet() {
  let allTS = DB.getStaffTimesheets();
  const i = allTS.findIndex(t => t.id === currentStaffTS.id);
  if (i >= 0) allTS[i] = currentStaffTS; else allTS.push(currentStaffTS);
  DB.setStaffTimesheets(allTS);
  toast('Timesheet saved');
}

function submitStaffTimesheet() {
  currentStaffTS.status = 'submitted';
  saveStaffTimesheet();
  navigate('staff-timesheet');
  toast('Timesheet submitted for approval');
}

function changeStaffWeek(days) {
  const d = new Date(staffWeekStart + 'T12:00:00');
  d.setDate(d.getDate() + days);
  staffWeekStart = d.toISOString().split('T')[0];
  currentStaffTS = null;
  navigate('staff-timesheet');
}

// ============================================================
// FIELD TIMESHEET (Timekeeper Entry)
// ============================================================
let fieldSelectedDate = new Date().toISOString().split('T')[0];
let fieldSelectedProject = '';
let fieldTSIndex = 0;

// Round raw hours to nearest 0.25 (15 min). At the midpoint (0.125), round up.
function roundToQuarter(hrs) {
  return Math.round(hrs * 4) / 4;
}

// Calculate badge hours with rounding to 0.25
function calcBadgeHours(clockIn, clockOut) {
  const [inH, inM] = clockIn.split(':').map(Number);
  const [outH, outM] = clockOut.split(':').map(Number);
  const raw = (outH + outM / 60) - (inH + inM / 60);
  return roundToQuarter(raw);
}

// Normalize a field record entry: supports both legacy (number) and new ({st,ot}) format
function getRecHours(rec) {
  if (typeof rec === 'number') return { st: rec, ot: 0 };
  if (rec && typeof rec === 'object') return { st: rec.st || 0, ot: rec.ot || 0 };
  return { st: 0, ot: 0 };
}
function getRecTotal(rec) { const h = getRecHours(rec); return h.st + h.ot; }

// Get total ST hours for an employee across ALL field timesheets for the week
function getEmpWeekSTTotal(empId, date) {
  const d = new Date(date + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  const allFieldTS = DB.getFieldTimesheets();
  let total = 0;
  allFieldTS.forEach(ts => {
    const tsDate = new Date(ts.date + 'T12:00:00');
    if (tsDate >= mon && tsDate <= sun) {
      ts.crewEntries.forEach(ce => {
        if (ce.empId === empId) {
          total += ce.records.reduce((a, r) => a + getRecHours(r).st, 0);
        }
      });
    }
  });
  return total;
}

// Get total entered hours for an employee on a specific date across ALL field timesheets
function getEmpDayTotal(empId, date) {
  const allFieldTS = DB.getFieldTimesheets();
  let total = 0;
  allFieldTS.forEach(ts => {
    if (ts.date === date) {
      ts.crewEntries.forEach(ce => {
        if (ce.empId === empId) {
          total += ce.records.reduce((a, r) => a + getRecTotal(r), 0);
        }
      });
    }
  });
  return total;
}

// Get total entered hours for an employee for the week containing a given date
function getEmpWeekTotal(empId, date) {
  const d = new Date(date + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  const allFieldTS = DB.getFieldTimesheets();
  let total = 0;
  allFieldTS.forEach(ts => {
    const tsDate = new Date(ts.date + 'T12:00:00');
    if (tsDate >= mon && tsDate <= sun) {
      ts.crewEntries.forEach(ce => {
        if (ce.empId === empId) {
          total += ce.records.reduce((a, r) => a + getRecTotal(r), 0);
        }
      });
    }
  });
  return total;
}

// Get badge hours for employee on a specific date
function getEmpBadgeHoursForDate(empId, date) {
  const badges = DB.getBadgeRecords().filter(b => b.empId === empId && b.date === date);
  return badges.reduce((sum, b) => sum + calcBadgeHours(b.clockIn, b.clockOut), 0);
}

// Get badge hours for employee for the week containing a given date
function getEmpBadgeHoursForWeek(empId, date) {
  const d = new Date(date + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  const badges = DB.getBadgeRecords().filter(b => {
    if (b.empId !== empId) return false;
    const bd = new Date(b.date + 'T12:00:00');
    return bd >= mon && bd <= sun;
  });
  return badges.reduce((sum, b) => sum + calcBadgeHours(b.clockIn, b.clockOut), 0);
}

function renderFieldTimesheet(mc) {
  const allFieldTS = DB.getFieldTimesheets();
  const projects = DB.getProjects().filter(p => p.active);

  // Get projects that actually have timesheets
  const projectsWithTS = [...new Set(allFieldTS.map(t => t.projectId))];

  if (allFieldTS.length === 0) {
    mc.innerHTML = `
      <div class="page-header"><h1>Field Timesheets</h1></div>
      <div class="card"><div class="card-body text-center" style="padding:40px;">
        <p class="text-muted">No field timesheets have been created yet.</p>
        <p class="text-muted mt-2">An admin needs to create timesheets first.</p>
      </div></div>
    `;
    return;
  }

  // If no project selected yet, default to first project that has timesheets
  if (!fieldSelectedProject && projectsWithTS.length > 0) {
    fieldSelectedProject = projectsWithTS[0];
  }

  // Filter by project first
  const projectTS = fieldSelectedProject ? allFieldTS.filter(t => t.projectId === fieldSelectedProject) : allFieldTS;

  // Get unique dates that have timesheets for this project
  const allDates = [...new Set(projectTS.map(t => t.date))].sort();
  if (!allDates.includes(fieldSelectedDate) && allDates.length > 0) {
    fieldSelectedDate = allDates[allDates.length - 1];
  }

  // Filter timesheets to selected project + date
  const dayTimesheets = projectTS.filter(t => t.date === fieldSelectedDate);
  if (fieldTSIndex >= dayTimesheets.length) fieldTSIndex = dayTimesheets.length - 1;
  if (fieldTSIndex < 0) fieldTSIndex = 0;

  const employees = DB.getEmployees();
  const areas = DB.getAreas();
  const taskCodes = DB.getTaskCodes();
  const fcos = DB.getFCOs();
  const cwps = DB.getCWPs();
  const badgeRecords = DB.getBadgeRecords();
  const badgeForDate = badgeRecords.filter(b => b.date === fieldSelectedDate);

  // Map from filtered index back to allFieldTS index (needed for saves)
  const globalIndex = dayTimesheets.length > 0 ? allFieldTS.indexOf(dayTimesheets[fieldTSIndex]) : -1;

  mc.innerHTML = `
    <div class="page-header">
      <h1>Field Timesheet Entry</h1>
      <div class="actions">
        ${dayTimesheets.length > 0 ? `
          <button class="btn btn-success" onclick="saveFieldTimesheet()">Save</button>
          <button class="btn btn-primary" onclick="submitFieldTimesheet()">Submit</button>
        ` : ''}
      </div>
    </div>

    <!-- Project & Date Selector -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-body" style="padding:12px 20px;">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <!-- Project Filter -->
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:14px;">Project:</strong>
            <select onchange="fieldSelectedProject=this.value;fieldTSIndex=0;navigate('field-timesheet')"
              style="padding:6px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:14px;min-width:220px;">
              ${projects.filter(p => projectsWithTS.includes(p.id)).map(p => `<option value="${p.id}" ${fieldSelectedProject === p.id ? 'selected' : ''}>${p.number} - ${p.name}</option>`).join('')}
            </select>
          </div>
          <!-- Date Filter -->
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:14px;">Day:</strong>
            <button class="btn btn-sm btn-outline" onclick="changeFieldDate(-1)">&larr;</button>
            <input type="date" value="${fieldSelectedDate}" onchange="fieldSelectedDate=this.value;fieldTSIndex=0;navigate('field-timesheet')"
              style="padding:6px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:14px;" />
            <button class="btn btn-sm btn-outline" onclick="changeFieldDate(1)">&rarr;</button>
          </div>
        </div>
        <div style="margin-top:8px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <span style="font-size:14px;color:var(--gray-600);">
            ${getDayName(fieldSelectedDate)} &mdash;
            <strong>${dayTimesheets.length}</strong> timesheet${dayTimesheets.length !== 1 ? 's' : ''} for this project/day
          </span>
          ${badgeForDate.length > 0 ? `
            <span class="badge-info" style="margin:0;padding:4px 10px;font-size:12px;">
              <span class="icon">&#128179;</span>
              ${badgeForDate.length} badge records available
            </span>
          ` : ''}
        </div>
      </div>
    </div>

    ${dayTimesheets.length === 0 ? `
      <div class="card"><div class="card-body text-center" style="padding:40px;">
        <p class="text-muted">No timesheets for <strong>${fieldSelectedProject ? getProjectName(fieldSelectedProject) : 'this project'}</strong> on ${formatDate(fieldSelectedDate)}.</p>
        <p class="text-muted mt-2">Select a different date or ask an admin to create a timesheet.</p>
        ${allDates.length > 0 ? `<p class="mt-4"><strong>Dates with timesheets for this project:</strong> ${allDates.map(d => `<button class="btn btn-sm btn-outline" style="margin:2px;" onclick="fieldSelectedDate='${d}';fieldTSIndex=0;navigate('field-timesheet')">${formatDate(d)}</button>`).join(' ')}</p>` : ''}
      </div></div>
    ` : `
      <!-- Timesheet Navigation within the day -->
      <div class="card">
        ${dayTimesheets.length > 1 ? `
        <div class="ts-nav">
          <div class="nav-arrows">
            <button onclick="fieldTSIndex=Math.max(0,fieldTSIndex-1);navigate('field-timesheet')" ${fieldTSIndex === 0 ? 'disabled' : ''}>&larr; Previous</button>
            <span class="counter">Sheet ${fieldTSIndex + 1} of ${dayTimesheets.length}</span>
            <button onclick="fieldTSIndex=Math.min(${dayTimesheets.length - 1},fieldTSIndex+1);navigate('field-timesheet')" ${fieldTSIndex === dayTimesheets.length - 1 ? 'disabled' : ''}>Next &rarr;</button>
          </div>
          <div>
            <select onchange="fieldTSIndex=parseInt(this.value);navigate('field-timesheet')" style="padding:6px 10px;border:1px solid var(--gray-300);border-radius:6px;">
              ${dayTimesheets.map((t, i) => `<option value="${i}" ${i === fieldTSIndex ? 'selected' : ''}>${t.timesheetNumber}</option>`).join('')}
            </select>
          </div>
        </div>
        ` : ''}

        <div class="ts-header">
          <div class="field"><label>Timesheet #</label><div class="value">${dayTimesheets[fieldTSIndex].timesheetNumber}</div></div>
          <div class="field"><label>Project</label><div class="value">${getProjectName(dayTimesheets[fieldTSIndex].projectId)}</div></div>
          <div class="field"><label>Foreman</label><div class="value">${getEmpName(dayTimesheets[fieldTSIndex].foreman)}</div></div>
          <div class="field"><label>Day</label><div class="value">${dayTimesheets[fieldTSIndex].day}</div></div>
          <div class="field"><label>Date</label><div class="value">${formatDate(dayTimesheets[fieldTSIndex].date)}</div></div>
          <div class="field"><label>Status</label><div class="value"><span class="badge badge-${dayTimesheets[fieldTSIndex].status}">${dayTimesheets[fieldTSIndex].status}</span></div></div>
        </div>

        ${(() => {
          const ts = dayTimesheets[fieldTSIndex];
          const projAreas = ts.projectId ? areas.filter(a => a.projectId === ts.projectId) : areas;
          // Ensure record-level arrays exist
          if (!ts.recordAreas) ts.recordAreas = Array(6).fill('');
          if (!ts.recordTaskCodes) ts.recordTaskCodes = Array(6).fill('');
          if (!ts.recordCWPs) ts.recordCWPs = Array(6).fill('');
          if (!ts.recordFCOs) ts.recordFCOs = Array(6).fill('');
          return '';
        })()}

        <div class="card-body" style="padding:0;overflow-x:auto;">
          <table class="data-table" id="field-table" style="border-collapse:collapse;">
            <colgroup>
              <col style="min-width:90px"><col style="min-width:80px"><col style="min-width:60px"><col style="min-width:50px">
              ${Array(6).fill(0).map(() => `<col style="min-width:48px"><col style="min-width:48px">`).join('')}
              <col style="min-width:55px"><col style="min-width:55px"><col style="min-width:55px"><col style="min-width:55px"><col style="min-width:30px">
            </colgroup>
            <thead>
              <!-- Area row -->
              <tr style="background:#e8f0fe;">
                <td colspan="3" rowspan="4" style="vertical-align:middle;background:var(--gray-50);border-right:2px solid var(--gray-300);text-align:center;"><strong style="font-size:12px;color:var(--gray-500);">EMPLOYEE INFO</strong></td>
                <td rowspan="4" style="vertical-align:middle;background:#fffbeb;border-right:2px solid var(--gray-300);text-align:center;"><strong style="font-size:11px;color:#92400e;">BADGE<br>DAY</strong></td>
                ${Array(6).fill(0).map((_, ri) => {
                  const curVal = (dayTimesheets[fieldTSIndex].recordAreas || [])[ri] || '';
                  const reqStyle = !curVal ? 'border-color:#dc2626;background:#fef2f2;' : '';
                  const projAreas2 = dayTimesheets[fieldTSIndex].projectId ? areas.filter(a => a.projectId === dayTimesheets[fieldTSIndex].projectId) : areas;
                  return `<td colspan="2" class="text-center" style="background:#e8f0fe;padding:4px;border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-200)'};">
                    <select onchange="updateRecordMeta(${globalIndex},${ri},'recordAreas',this.value);navigate('field-timesheet')" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--gray-300);border-radius:4px;${reqStyle}">
                      <option value="">Area *</option>
                      ${projAreas2.map(a => `<option value="${a.code}" ${curVal === a.code ? 'selected' : ''}>${a.code}</option>`).join('')}
                    </select></td>`;
                }).join('')}
                <td rowspan="4" style="vertical-align:middle;background:var(--gray-50);text-align:center;border-left:2px solid var(--gray-300);"><strong style="font-size:11px;">SHEET<br>TOTAL</strong></td>
                <td rowspan="4" style="vertical-align:middle;background:#dbeafe;text-align:center;"><strong style="font-size:11px;color:#1e40af;">WK<br>ST</strong></td>
                <td rowspan="4" style="vertical-align:middle;background:#eff6ff;text-align:center;"><strong style="font-size:11px;color:#1e40af;">DAY<br>TOTAL</strong></td>
                <td rowspan="4" style="vertical-align:middle;background:#fce4ec;text-align:center;"><strong style="font-size:11px;color:#b71c1c;">DAY<br>DIFF</strong></td>
                <td rowspan="4"></td>
              </tr>
              <!-- Task row -->
              <tr style="background:#f0f4ff;">
                ${Array(6).fill(0).map((_, ri) => {
                  const curVal = (dayTimesheets[fieldTSIndex].recordTaskCodes || [])[ri] || '';
                  const reqStyle = !curVal ? 'border-color:#dc2626;background:#fef2f2;' : '';
                  return `<td colspan="2" class="text-center" style="background:#f0f4ff;padding:4px;border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-200)'};">
                    <select onchange="updateRecordMeta(${globalIndex},${ri},'recordTaskCodes',this.value);navigate('field-timesheet')" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--gray-300);border-radius:4px;${reqStyle}">
                      <option value="">Task *</option>
                      ${taskCodes.map(t => `<option value="${t.code}" ${curVal === t.code ? 'selected' : ''}>${t.code}</option>`).join('')}
                    </select></td>`;
                }).join('')}
              </tr>
              <!-- CWP row -->
              <tr style="background:#f5f0ff;">
                ${Array(6).fill(0).map((_, ri) => {
                  const curVal = (dayTimesheets[fieldTSIndex].recordCWPs || [])[ri] || '';
                  return `<td colspan="2" class="text-center" style="background:#f5f0ff;padding:4px;border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-200)'};">
                    <select onchange="updateRecordMeta(${globalIndex},${ri},'recordCWPs',this.value);navigate('field-timesheet')" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--gray-300);border-radius:4px;">
                      <option value="">CWP</option>
                      ${cwps.map(c => `<option value="${c.code}" ${curVal === c.code ? 'selected' : ''}>${c.code}</option>`).join('')}
                    </select></td>`;
                }).join('')}
              </tr>
              <!-- FCO row -->
              <tr style="background:#f8f9fa;">
                ${Array(6).fill(0).map((_, ri) => {
                  const curVal = (dayTimesheets[fieldTSIndex].recordFCOs || [])[ri] || '';
                  return `<td colspan="2" class="text-center" style="background:#f8f9fa;padding:4px;border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-200)'};">
                    <select onchange="updateRecordMeta(${globalIndex},${ri},'recordFCOs',this.value);navigate('field-timesheet')" style="width:100%;font-size:11px;padding:2px 4px;border:1px solid var(--gray-300);border-radius:4px;">
                      <option value="">FCO</option>
                      ${fcos.map(f => `<option value="${f.code}" ${curVal === f.code ? 'selected' : ''}>${f.code}</option>`).join('')}
                    </select></td>`;
                }).join('')}
              </tr>
              <!-- Record number headers -->
              <tr>
                <th>Last Name</th><th>First Name</th><th>Emp. ID</th>
                <th class="text-center" style="background:#fef3c7;color:#92400e;">Hrs</th>
                ${Array(6).fill(0).map((_, ri) => `<th colspan="2" class="text-center" style="border-left:1px solid var(--gray-300);border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-300)'};">Rec ${ri + 1}</th>`).join('')}
                <th class="text-center">Total</th>
                <th class="text-center" style="background:#dbeafe;color:#1e40af;">Wk ST</th>
                <th class="text-center" style="background:#dbeafe;color:#1e40af;">Total</th>
                <th class="text-center" style="background:#fce4ec;color:#b71c1c;">Diff</th>
                <th></th>
              </tr>
              <!-- ST/OT sub-headers -->
              <tr>
                <th colspan="4"></th>
                ${Array(6).fill(0).map((_, ri) => `
                  <th class="text-center" style="font-size:10px;padding:2px 4px;background:#dbeafe;color:#1e40af;border-left:1px solid var(--gray-300);">ST</th>
                  <th class="text-center" style="font-size:10px;padding:2px 4px;background:#fce4ec;color:#b71c1c;border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-300)'};">OT</th>
                `).join('')}
                <th colspan="5"></th>
              </tr>
            </thead>
            <tbody>
              ${dayTimesheets[fieldTSIndex].crewEntries.map((entry, idx) => {
                const emp = employees.find(e => e.id === entry.empId);
                const recs = entry.records.slice(0, 6);
                const sheetTotal = recs.reduce((a, r) => a + getRecTotal(r), 0);
                const badgeDayHrs = getEffectiveBadgeHours(entry.empId, fieldSelectedDate);
                const hasOverride = hasBadgeOverride(entry.empId, fieldSelectedDate);
                const enteredDayTotal = getEmpDayTotal(entry.empId, fieldSelectedDate);
                const weekSTTotal = getEmpWeekSTTotal(entry.empId, fieldSelectedDate);
                const dayDiff = enteredDayTotal - badgeDayHrs;
                const diffColor = dayDiff > 0.25 ? 'color:var(--danger);font-weight:700;' : dayDiff < -0.25 ? 'color:var(--warning);font-weight:700;' : 'color:var(--success);';
                const badgeDisplay = badgeDayHrs > 0 ? badgeDayHrs.toFixed(2) : '--';
                const otAllowed = weekSTTotal >= 40;
                return `<tr>
                  <td>${emp ? emp.lastName : ''}</td>
                  <td>${emp ? emp.firstName : ''}</td>
                  <td>${entry.empId}</td>
                  <td class="text-center" style="background:#fffbeb;cursor:pointer;" onclick="showBadgeOverrideModal('${entry.empId}','${fieldSelectedDate}')" title="Click to override">
                    <strong>${badgeDisplay}</strong>
                    ${hasOverride ? '<br><span style="font-size:10px;color:#b45309;">OVR</span>' : ''}
                  </td>
                  ${recs.map((r, ri) => {
                    const h = getRecHours(r);
                    return `
                      <td style="border-left:1px solid var(--gray-300);padding:2px;"><input type="number" min="0" max="24" step="0.25" value="${h.st}" onchange="updateFieldRecord(${globalIndex},${idx},${ri},'st',this.value)" style="width:48px;" /></td>
                      <td style="border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-300)'};padding:2px;"><input type="number" min="0" max="24" step="0.25" value="${h.ot}" onchange="updateFieldRecord(${globalIndex},${idx},${ri},'ot',this.value)" ${!otAllowed ? 'disabled title="OT not allowed until 40 ST hours reached for the week (current: ' + weekSTTotal.toFixed(2) + ')"' : ''} style="width:48px;${!otAllowed ? 'opacity:0.4;cursor:not-allowed;' : ''}" /></td>
                    `;
                  }).join('')}
                  <td class="text-center"><strong>${sheetTotal.toFixed(2)}</strong></td>
                  <td class="text-center" style="background:#dbeafe;"><strong style="${weekSTTotal >= 40 ? 'color:var(--success);' : ''}">${weekSTTotal.toFixed(2)}</strong></td>
                  <td class="text-center" style="background:#eff6ff;"><strong>${enteredDayTotal.toFixed(2)}</strong></td>
                  <td class="text-center" style="background:#fce4ec;${diffColor}">${dayDiff > 0 ? '+' : ''}${dayDiff.toFixed(2)}</td>
                  <td>
                    <button class="btn btn-sm btn-outline" onclick="showBadgeOverrideModal('${entry.empId}','${fieldSelectedDate}')" title="Override badge time" style="font-size:11px;padding:3px 6px;">&#9998;</button>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
            <tfoot>
              <tr class="total-row">
                <td colspan="4"><strong>Totals</strong></td>
                ${Array(6).fill(0).map((_, ri) => {
                  const colST = dayTimesheets[fieldTSIndex].crewEntries.reduce((s, e) => s + getRecHours((e.records[ri] || {st:0,ot:0})).st, 0);
                  const colOT = dayTimesheets[fieldTSIndex].crewEntries.reduce((s, e) => s + getRecHours((e.records[ri] || {st:0,ot:0})).ot, 0);
                  return `<td class="text-center" style="border-left:1px solid var(--gray-300);"><strong>${colST.toFixed(2)}</strong></td><td class="text-center" style="border-right:${ri === 5 ? '2px solid var(--gray-300)' : '1px solid var(--gray-300)'};"><strong>${colOT.toFixed(2)}</strong></td>`;
                }).join('')}
                <td class="text-center"><strong>${dayTimesheets[fieldTSIndex].crewEntries.reduce((s, e) => s + e.records.slice(0,6).reduce((a, r) => a + getRecTotal(r), 0), 0).toFixed(2)}</strong></td>
                <td colspan="4"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- Legend -->
      <div class="card mt-2">
        <div class="card-body" style="padding:12px 20px;font-size:12px;color:var(--gray-600);display:flex;gap:24px;flex-wrap:wrap;">
          <span><span style="display:inline-block;width:12px;height:12px;background:#fffbeb;border:1px solid #f59e0b;border-radius:2px;vertical-align:middle;"></span> <strong>Badge Day</strong> = Clock hours from badge (rounded to 0.25). Click to override.</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#dbeafe;border:1px solid #1a56db;border-radius:2px;vertical-align:middle;"></span> <strong>Wk ST</strong> = Employee&rsquo;s total ST hours for the week (all projects). OT unlocks at 40.</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#eff6ff;border:1px solid #1a56db;border-radius:2px;vertical-align:middle;"></span> <strong>Day Total</strong> = Entered hours across all timesheets for the day</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#fce4ec;border:1px solid #b71c1c;border-radius:2px;vertical-align:middle;"></span> <strong>Day Diff</strong> = Entered &minus; Badge (green=match, red=over, orange=under)</span>
        </div>
      </div>
    `}
  `;
}

function changeFieldDate(days) {
  const d = new Date(fieldSelectedDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  fieldSelectedDate = d.toISOString().split('T')[0];
  fieldTSIndex = 0;
  navigate('field-timesheet');
}

function updateFieldRecord(globalIdx, crewIdx, recIdx, type, value) {
  // Snap to nearest 0.25
  let v = parseFloat(value) || 0;
  v = roundToQuarter(v);
  const allFieldTS = DB.getFieldTimesheets();
  let rec = allFieldTS[globalIdx].crewEntries[crewIdx].records[recIdx];
  // Migrate legacy number format to {st,ot} object
  if (typeof rec === 'number') {
    rec = { st: rec, ot: 0 };
  } else if (!rec || typeof rec !== 'object') {
    rec = { st: 0, ot: 0 };
  }

  // OT validation: only allow if employee has >= 40 ST hours for the week
  if (type === 'ot' && v > 0) {
    const empId = allFieldTS[globalIdx].crewEntries[crewIdx].empId;
    const date = allFieldTS[globalIdx].date;
    const weekST = getEmpWeekSTTotal(empId, date);
    if (weekST < 40) {
      toast(`OT not allowed: ${empId} has only ${weekST.toFixed(2)} ST hours this week (40 required).`, 'error');
      navigate('field-timesheet');
      return;
    }
  }

  rec[type] = v;
  allFieldTS[globalIdx].crewEntries[crewIdx].records[recIdx] = rec;
  DB.setFieldTimesheets(allFieldTS);
  navigate('field-timesheet');
}

function updateFieldTSHeader(globalIdx, field, value) {
  const allFieldTS = DB.getFieldTimesheets();
  allFieldTS[globalIdx][field] = value;
  DB.setFieldTimesheets(allFieldTS);
}

function updateRecordMeta(globalIdx, recIdx, arrayField, value) {
  const allFieldTS = DB.getFieldTimesheets();
  const ts = allFieldTS[globalIdx];
  if (!ts[arrayField]) ts[arrayField] = Array(6).fill('');
  ts[arrayField][recIdx] = value;
  DB.setFieldTimesheets(allFieldTS);
}

function updateFieldCrewField(globalIdx, crewIdx, field, value) {
  const allFieldTS = DB.getFieldTimesheets();
  allFieldTS[globalIdx].crewEntries[crewIdx][field] = value;
  DB.setFieldTimesheets(allFieldTS);
}

// --- Badge Override System ---
function getBadgeOverrides() { return DB._get('badgeOverrides') || []; }
function setBadgeOverrides(o) { DB._set('badgeOverrides', o); }

function hasBadgeOverride(empId, date) {
  return getBadgeOverrides().some(o => o.empId === empId && o.date === date);
}

function getEffectiveBadgeHours(empId, date) {
  const override = getBadgeOverrides().find(o => o.empId === empId && o.date === date);
  if (override) return override.hours;
  return getEmpBadgeHoursForDate(empId, date);
}

function showBadgeOverrideModal(empId, date) {
  const currentBadge = getEmpBadgeHoursForDate(empId, date);
  const existing = getBadgeOverrides().find(o => o.empId === empId && o.date === date);
  const badges = DB.getBadgeRecords().filter(b => b.empId === empId && b.date === date);
  const clockDetail = badges.map(b => `${b.clockIn} - ${b.clockOut}`).join(', ') || 'No badge records';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:500px;">
      <div class="modal-header">
        <h3>Badge Time Override</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div style="background:var(--gray-50);border-radius:6px;padding:12px;margin-bottom:16px;">
          <div style="font-size:13px;color:var(--gray-600);">
            <strong>Employee:</strong> ${getEmpName(empId)} (${empId})<br>
            <strong>Date:</strong> ${formatDate(date)}<br>
            <strong>Badge Clock Records:</strong> ${clockDetail}<br>
            <strong>Calculated Badge Hours:</strong> ${currentBadge.toFixed(2)}h (rounded to 0.25)
          </div>
        </div>
        ${existing ? `
          <div class="badge-info" style="margin-bottom:12px;">
            <span class="icon">&#9888;</span>
            Active override: ${existing.hours.toFixed(2)}h &mdash; "${existing.note}"
          </div>
        ` : ''}
        <div class="form-group">
          <label>Override Hours</label>
          <input type="number" id="override-hours" min="0" max="24" step="0.25" value="${existing ? existing.hours : currentBadge}" />
        </div>
        <div class="form-group">
          <label>Reason / Note (required)</label>
          <textarea id="override-note" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--gray-300);border-radius:6px;font-size:14px;resize:vertical;" placeholder="e.g., Badge malfunction, offsite work at client location, forgot to badge in/out...">${existing ? existing.note : ''}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        ${existing ? `<button class="btn btn-danger" onclick="removeBadgeOverride('${empId}','${date}')" style="margin-right:auto;">Remove Override</button>` : ''}
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-warning" onclick="saveBadgeOverride('${empId}','${date}')">Save Override</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function saveBadgeOverride(empId, date) {
  const hours = roundToQuarter(parseFloat(document.getElementById('override-hours').value) || 0);
  const note = document.getElementById('override-note').value.trim();
  if (!note) { toast('A reason/note is required for overrides', 'error'); return; }

  let overrides = getBadgeOverrides();
  const existing = overrides.findIndex(o => o.empId === empId && o.date === date);
  const entry = { empId, date, hours, note, overriddenBy: currentUser.name, overriddenAt: new Date().toISOString() };
  if (existing >= 0) overrides[existing] = entry; else overrides.push(entry);
  setBadgeOverrides(overrides);
  closeModal();
  navigate('field-timesheet');
  toast('Badge override saved');
}

function removeBadgeOverride(empId, date) {
  let overrides = getBadgeOverrides().filter(o => !(o.empId === empId && o.date === date));
  setBadgeOverrides(overrides);
  closeModal();
  navigate('field-timesheet');
  toast('Badge override removed');
}

function saveFieldTimesheet() {
  toast('Field timesheet saved');
}

function submitFieldTimesheet() {
  const allFieldTS = DB.getFieldTimesheets();
  const dayTimesheets = allFieldTS.filter(t => t.date === fieldSelectedDate);
  if (dayTimesheets.length === 0) return;
  const globalIdx = allFieldTS.indexOf(dayTimesheets[fieldTSIndex]);
  const ts = allFieldTS[globalIdx];

  // Validate mandatory Area and Task Code for any record column that has hours entered
  const recAreas = ts.recordAreas || Array(6).fill('');
  const recTasks = ts.recordTaskCodes || Array(6).fill('');
  for (let ri = 0; ri < 6; ri++) {
    const hasHours = ts.crewEntries.some(ce => getRecTotal(ce.records[ri]) > 0);
    if (hasHours) {
      if (!recAreas[ri]) {
        toast(`Record ${ri + 1} has hours entered but no Area assigned. Area is required.`, 'error');
        return;
      }
      if (!recTasks[ri]) {
        toast(`Record ${ri + 1} has hours entered but no Task Code assigned. Task Code is required.`, 'error');
        return;
      }
    }
  }

  allFieldTS[globalIdx].status = 'submitted';
  DB.setFieldTimesheets(allFieldTS);
  navigate('field-timesheet');
  toast('Field timesheet submitted');
}

// ============================================================
// WEEKLY RECONCILIATION CHECK
// ============================================================
let weeklyCheckDate = new Date().toISOString().split('T')[0];

function renderWeeklyCheck(mc) {
  // Get the Monday of the selected week
  const d = new Date(weeklyCheckDate + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const weekStart = mon.toISOString().split('T')[0];

  const weekDates = [];
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    weekDates.push(dd.toISOString().split('T')[0]);
  }

  const allFieldTS = DB.getFieldTimesheets();
  const employees = DB.getEmployees().filter(e => e.type === 'field' && e.active);
  const overrides = getBadgeOverrides();

  // Collect all field employees who have any timesheet entry this week
  const weekTS = allFieldTS.filter(ts => weekDates.includes(ts.date));
  const empIdsInWeek = new Set();
  weekTS.forEach(ts => ts.crewEntries.forEach(ce => empIdsInWeek.add(ce.empId)));

  // Also include employees with badge records this week
  const allBadges = DB.getBadgeRecords();
  allBadges.filter(b => weekDates.includes(b.date)).forEach(b => empIdsInWeek.add(b.empId));

  const empList = employees.filter(e => empIdsInWeek.has(e.id)).sort((a, b) => a.lastName.localeCompare(b.lastName));

  // Build per-employee data
  const empData = empList.map(emp => {
    const days = weekDates.map(date => {
      const badgeHrs = getEffectiveBadgeHours(emp.id, date);
      const enteredHrs = getEmpDayTotal(emp.id, date);
      const diff = enteredHrs - badgeHrs;
      const hasOvr = hasBadgeOverride(emp.id, date);
      return { date, badgeHrs, enteredHrs, diff, hasOvr };
    });
    const totalBadge = days.reduce((s, d) => s + d.badgeHrs, 0);
    const totalEntered = days.reduce((s, d) => s + d.enteredHrs, 0);
    const totalDiff = totalEntered - totalBadge;
    return { emp, days, totalBadge, totalEntered, totalDiff };
  });

  mc.innerHTML = `
    <div class="page-header">
      <h1>Weekly Reconciliation Check</h1>
    </div>

    <!-- Week Selector -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-body" style="padding:12px 20px;">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:14px;">Week of:</strong>
            <button class="btn btn-sm btn-outline" onclick="changeWeeklyCheck(-7)">&larr;</button>
            <input type="date" value="${weeklyCheckDate}" onchange="weeklyCheckDate=this.value;navigate('weekly-check')"
              style="padding:6px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:14px;" />
            <button class="btn btn-sm btn-outline" onclick="changeWeeklyCheck(7)">&rarr;</button>
          </div>
          <span style="font-size:14px;color:var(--gray-600);">
            ${formatDate(weekDates[0])} &ndash; ${formatDate(weekDates[6])} &mdash;
            <strong>${empList.length}</strong> employee${empList.length !== 1 ? 's' : ''} with activity
          </span>
        </div>
      </div>
    </div>

    ${empList.length === 0 ? `
      <div class="card"><div class="card-body text-center" style="padding:40px;">
        <p class="text-muted">No field employee activity found for this week.</p>
      </div></div>
    ` : `
      <div class="card">
        <div class="card-body" style="padding:0;overflow-x:auto;">
          <table class="data-table" id="weekly-check-table">
            <thead>
              <tr>
                <th rowspan="2" style="position:sticky;left:0;background:var(--gray-50);z-index:2;">Employee</th>
                <th rowspan="2" style="position:sticky;left:0;background:var(--gray-50);">ID</th>
                ${weekDates.slice(0, 5).map((dt, i) => `
                  <th colspan="3" class="text-center" style="background:var(--primary);color:white;font-size:11px;">
                    ${dayLabels[i]}<br>${dt.slice(5)}
                  </th>
                `).join('')}
                ${weekDates.slice(5).map((dt, i) => `
                  <th colspan="3" class="text-center" style="background:#6b7280;color:white;font-size:11px;">
                    ${dayLabels[i + 5]}<br>${dt.slice(5)}
                  </th>
                `).join('')}
                <th colspan="3" class="text-center" style="background:var(--gray-800);color:white;">Week Totals</th>
              </tr>
              <tr>
                ${weekDates.map(() => `
                  <th class="text-center" style="font-size:10px;background:#fef3c7;color:#92400e;">Badge</th>
                  <th class="text-center" style="font-size:10px;background:#dbeafe;color:#1e40af;">Entered</th>
                  <th class="text-center" style="font-size:10px;background:#fce4ec;color:#b71c1c;">Diff</th>
                `).join('')}
                <th class="text-center" style="font-size:10px;background:#fef3c7;color:#92400e;">Badge</th>
                <th class="text-center" style="font-size:10px;background:#dbeafe;color:#1e40af;">Entered</th>
                <th class="text-center" style="font-size:10px;background:#fce4ec;color:#b71c1c;">Diff</th>
              </tr>
            </thead>
            <tbody>
              ${empData.map(ed => {
                const weekDiffColor = ed.totalDiff > 0.25 ? 'color:var(--danger);font-weight:700;' : ed.totalDiff < -0.25 ? 'color:var(--warning);font-weight:700;' : 'color:var(--success);';
                return `<tr>
                  <td style="white-space:nowrap;"><strong>${ed.emp.lastName}, ${ed.emp.firstName}</strong></td>
                  <td>${ed.emp.id}</td>
                  ${ed.days.map(dy => {
                    const dc = dy.diff > 0.25 ? 'color:var(--danger);font-weight:700;' : dy.diff < -0.25 ? 'color:var(--warning);font-weight:700;' : 'color:var(--success);';
                    return `
                      <td class="text-center" style="background:#fffbeb;font-size:12px;">
                        ${dy.badgeHrs > 0 ? dy.badgeHrs.toFixed(2) : '--'}
                        ${dy.hasOvr ? '<span style="color:#b45309;" title="Override active">*</span>' : ''}
                      </td>
                      <td class="text-center" style="background:#eff6ff;font-size:12px;">${dy.enteredHrs > 0 ? dy.enteredHrs.toFixed(2) : '--'}</td>
                      <td class="text-center" style="background:#fce4ec;font-size:12px;${dc}">${(dy.badgeHrs > 0 || dy.enteredHrs > 0) ? (dy.diff > 0 ? '+' : '') + dy.diff.toFixed(2) : '--'}</td>
                    `;
                  }).join('')}
                  <td class="text-center" style="background:#fffbeb;font-weight:700;">${ed.totalBadge.toFixed(2)}</td>
                  <td class="text-center" style="background:#eff6ff;font-weight:700;">${ed.totalEntered.toFixed(2)}</td>
                  <td class="text-center" style="background:#fce4ec;font-weight:700;${weekDiffColor}">${ed.totalDiff > 0 ? '+' : ''}${ed.totalDiff.toFixed(2)}</td>
                </tr>`;
              }).join('')}
            </tbody>
            <tfoot>
              <tr class="total-row">
                <td colspan="2"><strong>All Employees</strong></td>
                ${weekDates.map(date => {
                  const dayBadge = empData.reduce((s, ed) => s + ed.days.find(dy => dy.date === date).badgeHrs, 0);
                  const dayEntered = empData.reduce((s, ed) => s + ed.days.find(dy => dy.date === date).enteredHrs, 0);
                  const dayDiff = dayEntered - dayBadge;
                  return `
                    <td class="text-center" style="background:#fffbeb;"><strong>${dayBadge.toFixed(2)}</strong></td>
                    <td class="text-center" style="background:#eff6ff;"><strong>${dayEntered.toFixed(2)}</strong></td>
                    <td class="text-center" style="background:#fce4ec;"><strong>${dayDiff > 0 ? '+' : ''}${dayDiff.toFixed(2)}</strong></td>
                  `;
                }).join('')}
                <td class="text-center" style="background:#fffbeb;"><strong>${empData.reduce((s, ed) => s + ed.totalBadge, 0).toFixed(2)}</strong></td>
                <td class="text-center" style="background:#eff6ff;"><strong>${empData.reduce((s, ed) => s + ed.totalEntered, 0).toFixed(2)}</strong></td>
                <td class="text-center" style="background:#fce4ec;"><strong>${(empData.reduce((s, ed) => s + ed.totalEntered, 0) - empData.reduce((s, ed) => s + ed.totalBadge, 0)).toFixed(2)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- Legend & Override Summary -->
      <div class="card mt-2">
        <div class="card-body" style="padding:12px 20px;font-size:12px;color:var(--gray-600);display:flex;gap:24px;flex-wrap:wrap;">
          <span><span style="color:var(--success);font-weight:700;">Green</span> = Entered matches badge (&plusmn;0.25h)</span>
          <span><span style="color:var(--danger);font-weight:700;">Red</span> = Over-entered (potential overpay)</span>
          <span><span style="color:var(--warning);font-weight:700;">Orange</span> = Under-entered (potential underpay)</span>
          <span><strong>*</strong> = Badge override active (click into Field Timesheets to view/edit)</span>
        </div>
      </div>

      ${getBadgeOverrides().filter(o => weekDates.includes(o.date)).length > 0 ? `
        <div class="card mt-2">
          <div class="card-header"><h3>Active Badge Overrides This Week</h3></div>
          <div class="card-body" style="padding:0;">
            <table class="data-table">
              <thead><tr><th>Employee</th><th>Date</th><th>Override Hours</th><th>Reason</th><th>Overridden By</th></tr></thead>
              <tbody>
                ${getBadgeOverrides().filter(o => weekDates.includes(o.date)).sort((a, b) => a.date.localeCompare(b.date)).map(o => `
                  <tr>
                    <td>${getEmpName(o.empId)}</td>
                    <td>${formatDate(o.date)}</td>
                    <td><strong>${o.hours.toFixed(2)}h</strong></td>
                    <td>${o.note}</td>
                    <td>${o.overriddenBy || '--'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}
    `}
  `;
}

function changeWeeklyCheck(days) {
  const d = new Date(weeklyCheckDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  weeklyCheckDate = d.toISOString().split('T')[0];
  navigate('weekly-check');
}

// ============================================================
// ADMIN - Manage Field Timesheets
// ============================================================
function renderAdminTimesheets(mc) {
  const fieldTS = DB.getFieldTimesheets();
  const projects = DB.getProjects().filter(p => p.active);
  const areas = DB.getAreas();
  const taskCodes = DB.getTaskCodes();
  const fcos = DB.getFCOs();
  const fieldEmps = DB.getEmployees().filter(e => e.type === 'field' && e.active);
  const foremen = fieldEmps.filter(e => e.craft === 'Foreman');

  mc.innerHTML = `
    <div class="page-header">
      <h1>Manage Field Timesheets</h1>
      <div class="actions">
        <button class="btn btn-success" onclick="showImportHoursModal()">&#128228; Import Hours</button>
        <button class="btn btn-primary" onclick="showCreateFieldTSModal()">+ Create Timesheet</button>
      </div>
    </div>

    <div class="card">
      <div class="card-body" style="padding:0;">
        <table class="data-table">
          <thead><tr>
            <th>Timesheet #</th><th>Project</th><th>Date</th><th>Foreman</th><th>Crew Size</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${fieldTS.map((ts, i) => `
              <tr>
                <td><strong>${ts.timesheetNumber}</strong></td>
                <td>${getProjectName(ts.projectId)}</td>
                <td>${formatDate(ts.date)}</td>
                <td>${getEmpName(ts.foreman)}</td>
                <td>${ts.crewEntries.length}</td>
                <td><span class="badge badge-${ts.status}">${ts.status}</span></td>
                <td>
                  <button class="btn btn-sm btn-outline" onclick="editFieldTSAdmin(${i})">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteFieldTS(${i})">&times;</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function showCreateFieldTSModal() {
  const projects = DB.getProjects().filter(p => p.active);
  const areas = DB.getAreas();
  const taskCodes = DB.getTaskCodes();
  const fcos = DB.getFCOs();
  const fieldEmps = DB.getEmployees().filter(e => e.type === 'field' && e.active);
  const nextNum = 'TS-' + new Date().getFullYear() + '-' + String(DB.getFieldTimesheets().length + 1).padStart(4, '0');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:700px;">
      <div class="modal-header">
        <h3>Create Field Timesheet</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label>Timesheet #</label>
            <input type="text" id="fts-number" value="${nextNum}" />
          </div>
          <div class="form-group">
            <label>Date</label>
            <input type="date" id="fts-date" value="${new Date().toISOString().split('T')[0]}" />
          </div>
        </div>
        <div class="form-group">
          <label>Project</label>
          <select id="fts-project">
            <option value="">Select project...</option>
            ${projects.map(p => `<option value="${p.id}">${p.number} - ${p.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Foreman</label>
          <select id="fts-foreman">
            ${fieldEmps.filter(e => e.craft === 'Foreman').map(e => `<option value="${e.id}">${e.firstName} ${e.lastName}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Assign Crew Members</label>
          <div style="border:1px solid var(--gray-200);border-radius:6px;max-height:220px;overflow-y:auto;padding:4px 0;">
            ${fieldEmps.filter(e => e.craft !== 'Foreman').map(e => `
              <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;font-size:14px;border-bottom:1px solid #f3f4f6;white-space:nowrap;">
                <input type="checkbox" class="crew-check" value="${e.id}" style="width:18px;height:18px;flex-shrink:0;cursor:pointer;" />
                <span><strong>${e.lastName}, ${e.firstName}</strong> &nbsp;(${e.id}) &mdash; ${e.craft}</span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="createFieldTS()">Create Timesheet</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function updateAreaOptions() {
  const projId = document.getElementById('fts-project').value;
  const areas = DB.getAreas().filter(a => !projId || a.projectId === projId);
  const sel = document.getElementById('fts-area');
  sel.innerHTML = '<option value="">Select area...</option>' + areas.map(a => `<option value="${a.code}">${a.code} - ${a.name}</option>`).join('');
}

function createFieldTS() {
  const checkedEmpIds = [...document.querySelectorAll('.crew-check:checked')].map(c => c.value);
  if (checkedEmpIds.length === 0) return toast('Select at least one crew member', 'error');

  const dateVal = document.getElementById('fts-date').value;
  const ts = {
    id: genId('FT'),
    timesheetNumber: document.getElementById('fts-number').value,
    projectId: document.getElementById('fts-project').value,
    areaCode: '',
    taskCode: '',
    fco: '',
    foreman: document.getElementById('fts-foreman').value,
    day: getDayName(dateVal),
    date: dateVal,
    status: 'open',
    crewEntries: checkedEmpIds.map(eid => ({ empId: eid, areaCode: '', taskCode: '', fco: '', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] }))
  };

  const all = DB.getFieldTimesheets();
  all.push(ts);
  DB.setFieldTimesheets(all);
  closeModal();
  navigate('admin-timesheets');
  toast('Field timesheet created');
}

function editFieldTSAdmin(idx) {
  fieldTSIndex = idx;
  navigate('field-timesheet');
}

function deleteFieldTS(idx) {
  if (!confirm('Delete this timesheet?')) return;
  const all = DB.getFieldTimesheets();
  all.splice(idx, 1);
  DB.setFieldTimesheets(all);
  navigate('admin-timesheets');
  toast('Timesheet deleted');
}

function closeModal() {
  const m = document.getElementById('modal-overlay');
  if (m) m.remove();
}

// ============================================================
// ADMIN - Employees
// ============================================================
function renderAdminEmployees(mc) {
  const emps = DB.getEmployees();
  mc.innerHTML = `
    <div class="page-header">
      <h1>Employee Management</h1>
      <div class="actions">
        <button class="btn btn-primary" onclick="showAddEmployeeModal()">+ Add Employee</button>
      </div>
    </div>
    <div class="card">
      <div class="card-body" style="padding:0;">
        <table class="data-table">
          <thead><tr><th>ID</th><th>Last Name</th><th>First Name</th><th>Type</th><th>Craft</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>
            ${emps.map((e, i) => `
              <tr>
                <td>${e.id}</td>
                <td>${e.lastName}</td>
                <td>${e.firstName}</td>
                <td>${e.type}</td>
                <td>${e.craft}</td>
                <td>${e.active ? '<span style="color:var(--success);">Active</span>' : '<span class="text-muted">Inactive</span>'}</td>
                <td>
                  <button class="btn btn-sm btn-outline" onclick="toggleEmployeeActive(${i})">${e.active ? 'Deactivate' : 'Activate'}</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function showAddEmployeeModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header"><h3>Add Employee</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group"><label>First Name</label><input type="text" id="emp-first" /></div>
          <div class="form-group"><label>Last Name</label><input type="text" id="emp-last" /></div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Type</label>
            <select id="emp-type"><option value="field">Field</option><option value="staff">Staff</option></select>
          </div>
          <div class="form-group"><label>Craft/Role</label><input type="text" id="emp-craft" /></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="addEmployee()">Add Employee</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function addEmployee() {
  const emps = DB.getEmployees();
  const newId = 'E' + String(emps.length + 1).padStart(3, '0');
  emps.push({
    id: newId,
    firstName: document.getElementById('emp-first').value,
    lastName: document.getElementById('emp-last').value,
    type: document.getElementById('emp-type').value,
    craft: document.getElementById('emp-craft').value,
    active: true
  });
  DB.setEmployees(emps);
  closeModal();
  navigate('admin-employees');
  toast('Employee added');
}

function toggleEmployeeActive(idx) {
  const emps = DB.getEmployees();
  emps[idx].active = !emps[idx].active;
  DB.setEmployees(emps);
  navigate('admin-employees');
}

// ============================================================
// ADMIN - Projects
// ============================================================
function renderAdminProjects(mc) {
  const projs = DB.getProjects();
  mc.innerHTML = `
    <div class="page-header">
      <h1>Project Management</h1>
      <div class="actions"><button class="btn btn-primary" onclick="showAddProjectModal()">+ Add Project</button></div>
    </div>
    <div class="card"><div class="card-body" style="padding:0;">
      <table class="data-table">
        <thead><tr><th>ID</th><th>Number</th><th>Name</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>
          ${projs.map((p, i) => `
            <tr>
              <td>${p.id}</td><td>${p.number}</td><td>${p.name}</td>
              <td>${p.active ? '<span style="color:var(--success);">Active</span>' : '<span class="text-muted">Inactive</span>'}</td>
              <td><button class="btn btn-sm btn-outline" onclick="toggleProjectActive(${i})">${p.active ? 'Deactivate' : 'Activate'}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div></div>
  `;
}

function showAddProjectModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header"><h3>Add Project</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
      <div class="modal-body">
        <div class="form-group"><label>Project Number</label><input type="text" id="proj-number" placeholder="e.g. 2024-005" /></div>
        <div class="form-group"><label>Project Name</label><input type="text" id="proj-name" /></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="addProject()">Add Project</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function addProject() {
  const projs = DB.getProjects();
  projs.push({
    id: genId('P'),
    number: document.getElementById('proj-number').value,
    name: document.getElementById('proj-name').value,
    active: true
  });
  DB.setProjects(projs);
  closeModal();
  navigate('admin-projects');
  toast('Project added');
}

function toggleProjectActive(idx) {
  const projs = DB.getProjects();
  projs[idx].active = !projs[idx].active;
  DB.setProjects(projs);
  navigate('admin-projects');
}

// ============================================================
// ADMIN - Codes & Areas
// ============================================================
function renderAdminCodes(mc) {
  const taskCodes = DB.getTaskCodes();
  const areas = DB.getAreas();
  const cwps = DB.getCWPs();
  const fcos = DB.getFCOs();

  mc.innerHTML = `
    <div class="page-header"><h1>Codes &amp; Areas</h1></div>

    <div class="tab-bar">
      <div class="tab-item active" onclick="showCodesTab('tasks',this)">Task Codes</div>
      <div class="tab-item" onclick="showCodesTab('areas',this)">Areas</div>
      <div class="tab-item" onclick="showCodesTab('cwps',this)">CWPs</div>
      <div class="tab-item" onclick="showCodesTab('fcos',this)">FCO/PCR</div>
    </div>

    <div id="codes-tab-tasks">
      <div class="card">
        <div class="card-header"><h3>Task Codes</h3><button class="btn btn-sm btn-primary" onclick="addTaskCode()">+ Add</button></div>
        <div class="card-body" style="padding:0;">
          <table class="data-table">
            <thead><tr><th>Code</th><th>Name</th></tr></thead>
            <tbody>${taskCodes.map(t => `<tr><td><strong>${t.code}</strong></td><td>${t.name}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="codes-tab-areas" class="hidden">
      <div class="card">
        <div class="card-header"><h3>Areas</h3><button class="btn btn-sm btn-primary" onclick="addArea()">+ Add</button></div>
        <div class="card-body" style="padding:0;">
          <table class="data-table">
            <thead><tr><th>Code</th><th>Name</th><th>Project</th></tr></thead>
            <tbody>${areas.map(a => `<tr><td><strong>${a.code}</strong></td><td>${a.name}</td><td>${getProjectName(a.projectId)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="codes-tab-cwps" class="hidden">
      <div class="card">
        <div class="card-header"><h3>Construction Work Packages (CWP)</h3><button class="btn btn-sm btn-primary" onclick="addCWP()">+ Add</button></div>
        <div class="card-body" style="padding:0;">
          <table class="data-table">
            <thead><tr><th>Code</th><th>Description</th></tr></thead>
            <tbody>${cwps.map(c => `<tr><td><strong>${c.code}</strong></td><td>${c.description}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="codes-tab-fcos" class="hidden">
      <div class="card">
        <div class="card-header"><h3>FCO / PCR</h3><button class="btn btn-sm btn-primary" onclick="addFCO()">+ Add</button></div>
        <div class="card-body" style="padding:0;">
          <table class="data-table">
            <thead><tr><th>Code</th><th>Description</th></tr></thead>
            <tbody>${fcos.map(f => `<tr><td><strong>${f.code}</strong></td><td>${f.description}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function showCodesTab(tab, el) {
  ['tasks', 'areas', 'cwps', 'fcos'].forEach(t => {
    document.getElementById('codes-tab-' + t).classList.toggle('hidden', t !== tab);
  });
  el.parentElement.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

function addTaskCode() {
  const code = prompt('Enter task code (e.g. MECH):');
  const name = prompt('Enter task name (e.g. Mechanical):');
  if (!code || !name) return;
  const tc = DB.getTaskCodes();
  tc.push({ id: genId('T'), code, name });
  DB.setTaskCodes(tc);
  navigate('admin-codes');
  toast('Task code added');
}

function addArea() {
  const code = prompt('Enter area code:');
  const name = prompt('Enter area name:');
  const projects = DB.getProjects().filter(p => p.active);
  const projId = prompt('Enter project ID (' + projects.map(p => p.id).join(', ') + '):');
  if (!code || !name) return;
  const areas = DB.getAreas();
  areas.push({ id: genId('A'), code, name, projectId: projId || '' });
  DB.setAreas(areas);
  navigate('admin-codes');
  toast('Area added');
}

function addCWP() {
  const code = prompt('Enter CWP code (e.g. CWP-005):');
  const desc = prompt('Enter description:');
  if (!code) return;
  const cwps = DB.getCWPs();
  cwps.push({ id: genId('CW'), code, description: desc || '' });
  DB.setCWPs(cwps);
  navigate('admin-codes');
  toast('CWP added');
}

function addFCO() {
  const code = prompt('Enter FCO/PCR code:');
  const desc = prompt('Enter description:');
  if (!code) return;
  const fcos = DB.getFCOs();
  fcos.push({ id: genId('F'), code, description: desc || '' });
  DB.setFCOs(fcos);
  navigate('admin-codes');
  toast('FCO/PCR added');
}

// ============================================================
// ADMIN - Badge System (Simulated)
// ============================================================
function renderAdminBadge(mc) {
  const badges = DB.getBadgeRecords();
  const fieldEmps = DB.getEmployees().filter(e => e.type === 'field' && e.active);

  mc.innerHTML = `
    <div class="page-header">
      <h1>Badge System (Simulated)</h1>
      <div class="actions">
        <button class="btn btn-primary" onclick="showAddBadgeModal()">+ Add Record</button>
        <button class="btn btn-outline" onclick="generateBadgeData()">Generate Sample Data</button>
      </div>
    </div>

    <div class="badge-info" style="margin-bottom:16px;">
      <span class="icon">&#9432;</span>
      This simulates clock-in/clock-out data from a badge system. In production, this would connect via API or data export.
    </div>

    <div class="card"><div class="card-body" style="padding:0;">
      <table class="data-table">
        <thead><tr><th>Employee</th><th>Date</th><th>Clock In</th><th>Clock Out</th><th>Hours</th><th>Source</th></tr></thead>
        <tbody>
          ${badges.sort((a, b) => b.date.localeCompare(a.date) || a.empId.localeCompare(b.empId)).map(b => {
            const hrs = calcBadgeHours(b.clockIn, b.clockOut);
            return `<tr>
              <td>${getEmpName(b.empId)}</td>
              <td>${formatDate(b.date)}</td>
              <td>${b.clockIn}</td>
              <td>${b.clockOut}</td>
              <td><strong>${hrs.toFixed(1)}h</strong></td>
              <td>${b.source}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div></div>
  `;
}

function showAddBadgeModal() {
  const fieldEmps = DB.getEmployees().filter(e => e.type === 'field' && e.active);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header"><h3>Add Badge Record</h3><button class="modal-close" onclick="closeModal()">&times;</button></div>
      <div class="modal-body">
        <div class="form-group"><label>Employee</label>
          <select id="badge-emp">${fieldEmps.map(e => `<option value="${e.id}">${e.lastName}, ${e.firstName}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label>Date</label><input type="date" id="badge-date" value="${new Date().toISOString().split('T')[0]}" /></div>
        <div class="form-row">
          <div class="form-group"><label>Clock In</label><input type="time" id="badge-in" value="06:00" /></div>
          <div class="form-group"><label>Clock Out</label><input type="time" id="badge-out" value="14:30" /></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="addBadgeRecord()">Add Record</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function addBadgeRecord() {
  const badges = DB.getBadgeRecords();
  badges.push({
    empId: document.getElementById('badge-emp').value,
    date: document.getElementById('badge-date').value,
    clockIn: document.getElementById('badge-in').value,
    clockOut: document.getElementById('badge-out').value,
    source: 'badge'
  });
  DB.setBadgeRecords(badges);
  closeModal();
  navigate('admin-badge');
  toast('Badge record added');
}

function generateBadgeData() {
  const fieldEmps = DB.getEmployees().filter(e => e.type === 'field' && e.active);
  const badges = DB.getBadgeRecords();
  const today = new Date();
  for (let d = 0; d < 5; d++) {
    const date = new Date(today);
    date.setDate(today.getDate() - d);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const dateStr = date.toISOString().split('T')[0];
    fieldEmps.forEach(e => {
      if (!badges.some(b => b.empId === e.id && b.date === dateStr)) {
        const startHour = 5 + Math.floor(Math.random() * 2);
        const startMin = Math.random() > 0.5 ? '00' : '30';
        const endHour = 14 + Math.floor(Math.random() * 3);
        const endMin = Math.random() > 0.5 ? '00' : '30';
        badges.push({
          empId: e.id,
          date: dateStr,
          clockIn: `${String(startHour).padStart(2,'0')}:${startMin}`,
          clockOut: `${String(endHour).padStart(2,'0')}:${endMin}`,
          source: 'badge'
        });
      }
    });
  }
  DB.setBadgeRecords(badges);
  navigate('admin-badge');
  toast('Sample badge data generated');
}

// ============================================================
// LABOR REPORT - Flattened Records View
// ============================================================
let laborReportWeek = new Date().toISOString().split('T')[0];
let laborReportProject = '';

function generateLaborRecords(filterProject, weekDate) {
  // Determine the week range
  const d = new Date(weekDate + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    weekDates.push(dd.toISOString().split('T')[0]);
  }

  const employees = DB.getEmployees();
  const projects = DB.getProjects();
  const records = [];

  // --- Staff Timesheets ---
  const dayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  DB.getStaffTimesheets().forEach(ts => {
    if (ts.weekStarting) {
      const tsWeekDates = getWeekDates(ts.weekStarting);
      ts.lines.forEach(line => {
        if (filterProject && line.projectId !== filterProject) return;
        const proj = projects.find(p => p.id === line.projectId);
        const emp = employees.find(e => e.id === ts.empId);

        dayKeys.forEach((dk, di) => {
          const dateStr = tsWeekDates[di];
          if (!weekDates.includes(dateStr)) return;

          const stHrs = line.hours[dk]?.st || 0;
          const otHrs = line.hours[dk]?.ot || 0;

          if (stHrs > 0) {
            records.push({
              source: 'Staff',
              empId: ts.empId,
              empName: emp ? `${emp.lastName}, ${emp.firstName}` : ts.empId,
              craft: emp ? emp.craft : '',
              date: dateStr,
              day: getDayName(dateStr),
              projectId: line.projectId,
              projectNum: proj ? proj.number : '',
              projectName: proj ? proj.name : '',
              area: line.area,
              taskCode: line.taskCode,
              cwp: line.cwp || '',
              fco: line.fco,
              comment: line.comment || '',
              type: 'ST',
              hours: stHrs,
            });
          }
          if (otHrs > 0) {
            records.push({
              source: 'Staff',
              empId: ts.empId,
              empName: emp ? `${emp.lastName}, ${emp.firstName}` : ts.empId,
              craft: emp ? emp.craft : '',
              date: dateStr,
              day: getDayName(dateStr),
              projectId: line.projectId,
              projectNum: proj ? proj.number : '',
              projectName: proj ? proj.name : '',
              area: line.area,
              taskCode: line.taskCode,
              cwp: line.cwp || '',
              fco: line.fco,
              comment: line.comment || '',
              type: 'OT',
              hours: otHrs,
            });
          }
        });
      });
    }
  });

  // --- Field Timesheets ---
  DB.getFieldTimesheets().forEach(ts => {
    if (!weekDates.includes(ts.date)) return;
    if (filterProject && ts.projectId !== filterProject) return;

    const proj = projects.find(p => p.id === ts.projectId);
    const recAreas = ts.recordAreas || Array(6).fill('');
    const recTasks = ts.recordTaskCodes || Array(6).fill('');
    const recCWPs = ts.recordCWPs || Array(6).fill('');
    const recFCOs = ts.recordFCOs || Array(6).fill('');

    ts.crewEntries.forEach(ce => {
      const emp = employees.find(e => e.id === ce.empId);

      ce.records.forEach((rec, ri) => {
        const h = getRecHours(rec);
        const baseFields = {
          source: 'Field',
          empId: ce.empId,
          empName: emp ? `${emp.lastName}, ${emp.firstName}` : ce.empId,
          craft: emp ? emp.craft : '',
          date: ts.date,
          day: getDayName(ts.date),
          projectId: ts.projectId,
          projectNum: proj ? proj.number : '',
          projectName: proj ? proj.name : '',
          area: recAreas[ri] || ts.areaCode || '',
          taskCode: recTasks[ri] || ts.taskCode || '',
          cwp: recCWPs[ri] || '',
          fco: recFCOs[ri] || ts.fco || '',
          comment: '',
        };
        if (h.st > 0) {
          records.push({ ...baseFields, type: 'ST', hours: h.st });
        }
        if (h.ot > 0) {
          records.push({ ...baseFields, type: 'OT', hours: h.ot });
        }
      });
    });
  });

  // Sort by date, then employee
  records.sort((a, b) => a.date.localeCompare(b.date) || a.empName.localeCompare(b.empName));
  return records;
}

function renderLaborCostReport(mc) {
  const projects = DB.getProjects();
  const records = generateLaborRecords(laborReportProject, laborReportWeek);

  const totalHours = records.reduce((s, r) => s + r.hours, 0);

  // Week range for display
  const d = new Date(laborReportWeek + 'T12:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  mc.innerHTML = `
    <div class="page-header">
      <h1>Labor Report</h1>
      <div class="actions">
        <button class="btn btn-success" onclick="exportLaborToExcel()">Export CSV</button>
        <button class="btn btn-outline" onclick="exportLaborJSON()">Export JSON</button>
      </div>
    </div>

    <!-- Filters -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-body" style="padding:12px 20px;">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:14px;">Week of:</strong>
            <button class="btn btn-sm btn-outline" onclick="changeLaborWeek(-7)">&larr;</button>
            <input type="date" value="${laborReportWeek}" onchange="laborReportWeek=this.value;navigate('labor-cost')"
              style="padding:6px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:14px;" />
            <button class="btn btn-sm btn-outline" onclick="changeLaborWeek(7)">&rarr;</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <strong style="font-size:14px;">Project:</strong>
            <select onchange="laborReportProject=this.value;navigate('labor-cost')"
              style="padding:6px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:14px;min-width:200px;">
              <option value="">All Projects</option>
              ${projects.map(p => `<option value="${p.id}" ${laborReportProject === p.id ? 'selected' : ''}>${p.number} - ${p.name}</option>`).join('')}
            </select>
          </div>
          <span style="font-size:13px;color:var(--gray-500);">
            ${formatDate(mon.toISOString().split('T')[0])} &ndash; ${formatDate(sun.toISOString().split('T')[0])}
          </span>
        </div>
      </div>
    </div>

    <!-- Summary -->
    <div class="stats-grid" style="margin-bottom:16px;">
      <div class="stat-card">
        <div class="stat-label">Total Records</div>
        <div class="stat-value">${records.length}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Hours</div>
        <div class="stat-value">${totalHours.toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">ST Hours</div>
        <div class="stat-value">${records.filter(r => r.type === 'ST').reduce((s, r) => s + r.hours, 0).toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">OT Hours</div>
        <div class="stat-value">${records.filter(r => r.type === 'OT').reduce((s, r) => s + r.hours, 0).toFixed(2)}</div>
      </div>
    </div>

    <!-- Records Table -->
    <div class="card">
      <div class="card-header">
        <h3>Detailed Labor Records (${records.length} rows)</h3>
      </div>
      <div class="card-body" style="padding:0;overflow-x:auto;">
        <table class="data-table" id="labor-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Employee</th>
              <th>ID</th>
              <th>Craft</th>
              <th>Date</th>
              <th>Day</th>
              <th>Project</th>
              <th>Area</th>
              <th>Task</th>
              <th>CWP</th>
              <th>FCO</th>
              <th>Type</th>
              <th class="text-right">Hours</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            ${records.length === 0 ? `<tr><td colspan="15" class="text-center text-muted" style="padding:30px;">No records found for this week/project selection.</td></tr>` : ''}
            ${records.map(r => {
              const typeColor = r.type === 'OT' ? 'color:var(--danger);font-weight:700;' : '';
              return `<tr>
                <td><span class="badge ${r.source === 'Staff' ? 'badge-open' : 'badge-submitted'}">${r.source}</span></td>
                <td><strong>${r.empName}</strong></td>
                <td>${r.empId}</td>
                <td>${r.craft}</td>
                <td>${formatDate(r.date)}</td>
                <td>${r.day}</td>
                <td>${r.projectNum}</td>
                <td>${r.area}</td>
                <td>${r.taskCode}</td>
                <td>${r.cwp || '--'}</td>
                <td>${r.fco || '--'}</td>
                <td style="${typeColor}">${r.type}</td>
                <td class="text-right"><strong>${r.hours.toFixed(2)}</strong></td>
                <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(r.comment || '').replace(/"/g, '&quot;')}">${r.comment || '--'}</td>
              </tr>`;
            }).join('')}
          </tbody>
          ${records.length > 0 ? `
          <tfoot>
            <tr class="total-row">
              <td colspan="13"><strong>Totals</strong></td>
              <td class="text-right"><strong>${totalHours.toFixed(2)}</strong></td>
              <td></td>
            </tr>
          </tfoot>
          ` : ''}
        </table>
      </div>
    </div>
  `;
}

function changeLaborWeek(days) {
  const d = new Date(laborReportWeek + 'T12:00:00');
  d.setDate(d.getDate() + days);
  laborReportWeek = d.toISOString().split('T')[0];
  navigate('labor-cost');
}

// --- Export ---
function exportLaborToExcel() {
  const records = generateLaborRecords(laborReportProject, laborReportWeek);
  if (records.length === 0) { toast('No records to export', 'error'); return; }

  const headers = ['Source','Employee','Emp ID','Craft','Date','Day','Project #','Project Name','Area','Task Code','CWP','FCO/PCR','Type','Hours','Comment'];
  const rows = records.map(r => [
    r.source, r.empName, r.empId, r.craft, r.date, r.day, r.projectNum, r.projectName,
    r.area, r.taskCode, r.cwp, r.fco, r.type, r.hours, r.comment,
  ]);

  const totalH = records.reduce((s, r) => s + r.hours, 0);
  rows.push(['','','','','','','','','','','','','TOTALS', totalH, '']);

  // Tab-separated for clean Excel paste, with .csv for broad compat
  const csvContent = [headers, ...rows].map(row =>
    row.map(cell => {
      const s = typeof cell === 'number' ? cell.toFixed(2) : String(cell);
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Labor_Report_${laborReportWeek}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Labor report exported as CSV');
}

function exportLaborJSON() {
  const records = generateLaborRecords(laborReportProject, laborReportWeek);
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Labor_Records_${laborReportWeek}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('JSON export complete');
}

// ============================================================
// IMPORT HOURS - CSV Import for Field Timesheets
// ============================================================

function showImportHoursModal() {
  const fieldTS = DB.getFieldTimesheets();
  const projects = DB.getProjects().filter(p => p.active);
  const projectsWithTS = [...new Set(fieldTS.map(t => t.projectId))];

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:720px;">
      <div class="modal-header">
        <h3>Import Hours from CSV</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <!-- Step 1: Select timesheet -->
        <div id="import-step-1">
          <p style="margin-bottom:12px;color:var(--gray-600);font-size:14px;">Select the project, date, and timesheet you want to import hours into.</p>

          <div class="form-row">
            <div class="form-group">
              <label>Project</label>
              <select id="import-project" onchange="updateImportTimesheets()">
                <option value="">Select project...</option>
                ${projects.filter(p => projectsWithTS.includes(p.id)).map(p => `<option value="${p.id}">${p.number} - ${p.name}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Date</label>
              <select id="import-date" onchange="updateImportTimesheets()">
                <option value="">Select project first...</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label>Timesheet</label>
            <select id="import-timesheet">
              <option value="">Select project & date first...</option>
            </select>
          </div>

          <div class="form-group" style="margin-top:16px;">
            <label>CSV File</label>
            <input type="file" id="import-file" accept=".csv" style="padding:8px;border:2px dashed var(--gray-300);border-radius:8px;width:100%;cursor:pointer;" />
          </div>

          <div style="margin-top:16px;padding:12px 16px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
              <strong style="font-size:13px;color:#0369a1;">CSV Format Requirements</strong>
              <button class="btn btn-sm btn-outline" onclick="downloadImportTemplate()" style="font-size:11px;">&#128196; Download Template</button>
            </div>
            <p style="font-size:12px;color:#0c4a6e;margin:0;">
              First 4 rows define record attributes (one value per record column):<br/>
              <code>Area, [Rec1 Area], [Rec2 Area], ... [Rec6 Area]</code><br/>
              <code>Task Code, [Rec1 Task], [Rec2 Task], ... [Rec6 Task]</code><br/>
              <code>CWP, [Rec1 CWP], [Rec2 CWP], ... [Rec6 CWP]</code><br/>
              <code>FCO, [Rec1 FCO], [Rec2 FCO], ... [Rec6 FCO]</code><br/><br/>
              Then employee rows with hours:<br/>
              <code>Employee ID, Rec1 ST, Rec1 OT, Rec2 ST, Rec2 OT, ... Rec6 ST, Rec6 OT</code><br/>
              Employee IDs must match crew members already on the timesheet.
            </p>
          </div>
        </div>

        <!-- Step 2: Preview (populated by JS) -->
        <div id="import-step-2" style="display:none;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="import-next-btn" onclick="previewImport()">Preview Import</button>
        <button class="btn btn-success" id="import-confirm-btn" onclick="confirmImport()" style="display:none;">Confirm Import</button>
        <button class="btn btn-outline" id="import-back-btn" onclick="importGoBack()" style="display:none;">Back</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function updateImportTimesheets() {
  const projId = document.getElementById('import-project').value;
  const dateSel = document.getElementById('import-date');
  const tsSel = document.getElementById('import-timesheet');

  if (!projId) {
    dateSel.innerHTML = '<option value="">Select project first...</option>';
    tsSel.innerHTML = '<option value="">Select project & date first...</option>';
    return;
  }

  const fieldTS = DB.getFieldTimesheets();
  const projTS = fieldTS.filter(t => t.projectId === projId);
  const dates = [...new Set(projTS.map(t => t.date))].sort();

  dateSel.innerHTML = '<option value="">Select date...</option>' + dates.map(d => `<option value="${d}">${formatDate(d)} (${getDayName(d)})</option>`).join('');

  dateSel.onchange = function() {
    const dateVal = this.value;
    if (!dateVal) {
      tsSel.innerHTML = '<option value="">Select date first...</option>';
      return;
    }
    const dayTS = projTS.filter(t => t.date === dateVal);
    tsSel.innerHTML = '<option value="">Select timesheet...</option>' + dayTS.map(t => `<option value="${t.id}">${t.timesheetNumber} — ${getEmpName(t.foreman)} (${t.crewEntries.length} crew)</option>`).join('');
  };

  tsSel.innerHTML = '<option value="">Select date first...</option>';
}

function downloadImportTemplate() {
  const tsId = document.getElementById('import-timesheet').value;
  const fieldTS = DB.getFieldTimesheets();
  const ts = fieldTS.find(t => t.id === tsId);

  // Get valid codes for reference comments
  const areas = ts ? DB.getAreas().filter(a => a.projectId === ts.projectId) : DB.getAreas();
  const taskCodes = DB.getTaskCodes();
  const cwps = DB.getCWPs();
  const fcos = DB.getFCOs();

  // Metadata rows — pre-fill from existing timesheet if available
  const existAreas = (ts && ts.recordAreas) || Array(6).fill('');
  const existTasks = (ts && ts.recordTaskCodes) || Array(6).fill('');
  const existCWPs = (ts && ts.recordCWPs) || Array(6).fill('');
  const existFCOs = (ts && ts.recordFCOs) || Array(6).fill('');

  let csvContent = '';
  csvContent += `Area,${existAreas.join(',')}\n`;
  csvContent += `Task Code,${existTasks.join(',')}\n`;
  csvContent += `CWP,${existCWPs.join(',')}\n`;
  csvContent += `FCO,${existFCOs.join(',')}\n`;
  csvContent += 'Employee ID,Rec1 ST,Rec1 OT,Rec2 ST,Rec2 OT,Rec3 ST,Rec3 OT,Rec4 ST,Rec4 OT,Rec5 ST,Rec5 OT,Rec6 ST,Rec6 OT\n';

  if (ts) {
    ts.crewEntries.forEach(entry => {
      const recs = entry.records || [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}];
      csvContent += `${entry.empId},${recs.map(r => `${r.st},${r.ot}`).join(',')}\n`;
    });
  } else {
    csvContent += 'E004,0,0,0,0,0,0,0,0,0,0,0,0\n';
    csvContent += 'E005,0,0,0,0,0,0,0,0,0,0,0,0\n';
  }

  // Append reference comment lines listing valid codes
  csvContent += '\n';
  csvContent += `"# Valid Areas: ${areas.map(a => a.code).join(', ')}"\n`;
  csvContent += `"# Valid Task Codes: ${taskCodes.map(t => t.code).join(', ')}"\n`;
  csvContent += `"# Valid CWPs: ${cwps.map(c => c.code).join(', ')}"\n`;
  csvContent += `"# Valid FCOs: ${fcos.map(f => f.code).join(', ')}"\n`;

  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ts ? `import_template_${ts.timesheetNumber}.csv` : 'import_template.csv';
  a.click();
  URL.revokeObjectURL(url);
  toast('Template downloaded');
}

function parseCSV(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('"#'));
  if (lines.length < 6) return { meta: null, rows: [] }; // Need 4 meta + 1 header + at least 1 data row

  // Parse 4 metadata rows: Area, Task Code, CWP, FCO
  const metaRows = lines.slice(0, 4).map(line => {
    const cols = line.split(',').map(c => c.trim());
    return cols.slice(1, 7).map(v => v || ''); // 6 values, skip label column
  });

  const meta = {
    areas: metaRows[0],
    taskCodes: metaRows[1],
    cwps: metaRows[2],
    fcos: metaRows[3]
  };

  // Skip header row (line 5), parse employee rows (line 6+)
  const rows = lines.slice(5).map(line => {
    const cols = line.split(',').map(c => c.trim());
    if (!cols[0] || cols[0].startsWith('#')) return null; // skip comments
    return {
      empId: cols[0],
      records: [
        { st: parseFloat(cols[1]) || 0, ot: parseFloat(cols[2]) || 0 },
        { st: parseFloat(cols[3]) || 0, ot: parseFloat(cols[4]) || 0 },
        { st: parseFloat(cols[5]) || 0, ot: parseFloat(cols[6]) || 0 },
        { st: parseFloat(cols[7]) || 0, ot: parseFloat(cols[8]) || 0 },
        { st: parseFloat(cols[9]) || 0, ot: parseFloat(cols[10]) || 0 },
        { st: parseFloat(cols[11]) || 0, ot: parseFloat(cols[12]) || 0 },
      ]
    };
  }).filter(r => r !== null);

  return { meta, rows };
}

// Temporarily holds parsed import data between preview and confirm
let pendingImportData = null;

function previewImport() {
  const tsId = document.getElementById('import-timesheet').value;
  const fileInput = document.getElementById('import-file');

  if (!tsId) return toast('Please select a timesheet', 'error');
  if (!fileInput.files || fileInput.files.length === 0) return toast('Please select a CSV file', 'error');

  const reader = new FileReader();
  reader.onload = function(e) {
    const parsed = parseCSV(e.target.result);
    if (!parsed.meta || parsed.rows.length === 0) return toast('CSV is empty or invalid. Ensure 4 attribute rows + header + employee rows.', 'error');

    const fieldTS = DB.getFieldTimesheets();
    const ts = fieldTS.find(t => t.id === tsId);
    if (!ts) return toast('Timesheet not found', 'error');

    const crewIds = ts.crewEntries.map(c => c.empId);
    const employees = DB.getEmployees();
    const meta = parsed.meta;

    // Validate attribute codes
    const validAreas = DB.getAreas().filter(a => a.projectId === ts.projectId).map(a => a.code);
    const validTasks = DB.getTaskCodes().map(t => t.code);
    const validCWPs = DB.getCWPs().map(c => c.code);
    const validFCOs = DB.getFCOs().map(f => f.code);

    let previewHTML = '';
    let warnings = [];
    let conflicts = [];
    let validRows = [];

    // Validate metadata
    meta.areas.forEach((v, i) => {
      if (v && !validAreas.includes(v)) warnings.push(`Record ${i+1} Area "<strong>${v}</strong>" is not a valid area code for this project.`);
    });
    meta.taskCodes.forEach((v, i) => {
      if (v && !validTasks.includes(v)) warnings.push(`Record ${i+1} Task Code "<strong>${v}</strong>" is not a valid task code.`);
    });
    meta.cwps.forEach((v, i) => {
      if (v && !validCWPs.includes(v)) warnings.push(`Record ${i+1} CWP "<strong>${v}</strong>" is not a valid CWP code.`);
    });
    meta.fcos.forEach((v, i) => {
      if (v && !validFCOs.includes(v)) warnings.push(`Record ${i+1} FCO "<strong>${v}</strong>" is not a valid FCO code.`);
    });

    parsed.rows.forEach(row => {
      const emp = employees.find(e => e.id === row.empId);
      const empName = emp ? `${emp.lastName}, ${emp.firstName}` : row.empId;

      if (!crewIds.includes(row.empId)) {
        warnings.push(`<strong>${empName}</strong> (${row.empId}) is not on this timesheet — will be skipped.`);
        return;
      }

      const existingEntry = ts.crewEntries.find(c => c.empId === row.empId);
      const hasExisting = existingEntry.records.some(r => r.st > 0 || r.ot > 0);

      validRows.push(row);

      if (hasExisting) {
        conflicts.push({
          empId: row.empId,
          empName: empName,
          existing: existingEntry.records.slice(0, 6),
          incoming: row.records
        });
      }
    });

    // Build preview UI
    let html = '';

    // Show attribute assignments
    const existAreas = ts.recordAreas || Array(6).fill('');
    const existTasks = ts.recordTaskCodes || Array(6).fill('');
    const existCWPs = ts.recordCWPs || Array(6).fill('');
    const existFCOs = ts.recordFCOs || Array(6).fill('');
    const hasMetaChanges = meta.areas.some((v, i) => v && v !== existAreas[i]) ||
                           meta.taskCodes.some((v, i) => v && v !== existTasks[i]) ||
                           meta.cwps.some((v, i) => v && v !== existCWPs[i]) ||
                           meta.fcos.some((v, i) => v && v !== existFCOs[i]);

    html += `<div style="padding:10px 14px;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;margin-bottom:12px;">
      <strong style="color:#1e40af;font-size:13px;">&#128203; Record Attributes${hasMetaChanges ? ' (changes detected)' : ''}</strong>
      <div style="margin-top:8px;font-size:12px;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="background:#dbeafe;">
            <th style="padding:4px 8px;text-align:left;font-size:11px;">Attribute</th>
            ${Array(6).fill(0).map((_, i) => `<th style="padding:4px 6px;text-align:center;font-size:11px;">Rec ${i+1}</th>`).join('')}
          </tr></thead>
          <tbody>
            <tr style="border-top:1px solid #bfdbfe;">
              <td style="padding:4px 8px;font-weight:600;">Area</td>
              ${meta.areas.map((v, i) => {
                const changed = v && v !== existAreas[i];
                return `<td style="padding:4px 6px;text-align:center;${changed ? 'background:#fef9c3;font-weight:600;' : ''}">${v || '<span style="color:#9ca3af;">—</span>'}</td>`;
              }).join('')}
            </tr>
            <tr style="border-top:1px solid #bfdbfe;">
              <td style="padding:4px 8px;font-weight:600;">Task Code</td>
              ${meta.taskCodes.map((v, i) => {
                const changed = v && v !== existTasks[i];
                return `<td style="padding:4px 6px;text-align:center;${changed ? 'background:#fef9c3;font-weight:600;' : ''}">${v || '<span style="color:#9ca3af;">—</span>'}</td>`;
              }).join('')}
            </tr>
            <tr style="border-top:1px solid #bfdbfe;">
              <td style="padding:4px 8px;font-weight:600;">CWP</td>
              ${meta.cwps.map((v, i) => {
                const changed = v && v !== existCWPs[i];
                return `<td style="padding:4px 6px;text-align:center;${changed ? 'background:#fef9c3;font-weight:600;' : ''}">${v || '<span style="color:#9ca3af;">—</span>'}</td>`;
              }).join('')}
            </tr>
            <tr style="border-top:1px solid #bfdbfe;">
              <td style="padding:4px 8px;font-weight:600;">FCO</td>
              ${meta.fcos.map((v, i) => {
                const changed = v && v !== existFCOs[i];
                return `<td style="padding:4px 6px;text-align:center;${changed ? 'background:#fef9c3;font-weight:600;' : ''}">${v || '<span style="color:#9ca3af;">—</span>'}</td>`;
              }).join('')}
            </tr>
          </tbody>
        </table>
      </div>
    </div>`;

    if (warnings.length > 0) {
      html += `<div style="padding:10px 14px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;margin-bottom:12px;">
        <strong style="color:#92400e;font-size:13px;">&#9888; Warnings</strong>
        <ul style="margin:6px 0 0 16px;font-size:13px;color:#78350f;">
          ${warnings.map(w => `<li>${w}</li>`).join('')}
        </ul>
      </div>`;
    }

    if (conflicts.length > 0) {
      html += `<div style="padding:10px 14px;background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;margin-bottom:12px;">
        <strong style="color:#991b1b;font-size:13px;">&#9888; Conflicts — Existing hours will be replaced</strong>
        <div style="margin-top:8px;font-size:12px;max-height:200px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#fecaca;">
              <th style="padding:4px 8px;text-align:left;">Employee</th>
              <th style="padding:4px 8px;text-align:center;">Current Total</th>
              <th style="padding:4px 8px;text-align:center;">New Total</th>
            </tr></thead>
            <tbody>
              ${conflicts.map(c => {
                const curTotal = c.existing.reduce((a, r) => a + r.st + r.ot, 0);
                const newTotal = c.incoming.reduce((a, r) => a + r.st + r.ot, 0);
                return `<tr style="border-top:1px solid #fecaca;">
                  <td style="padding:4px 8px;"><strong>${c.empName}</strong></td>
                  <td style="padding:4px 8px;text-align:center;">${curTotal.toFixed(1)} hrs</td>
                  <td style="padding:4px 8px;text-align:center;color:#991b1b;font-weight:600;">${newTotal.toFixed(1)} hrs</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }

    if (validRows.length > 0) {
      html += `<div style="padding:10px 14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;">
        <strong style="color:#166534;font-size:13px;">&#10003; ${validRows.length} employee(s) will be updated</strong>
        <div style="margin-top:8px;font-size:12px;max-height:200px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#dcfce7;">
              <th style="padding:4px 8px;text-align:left;">Employee</th>
              ${Array(6).fill(0).map((_, i) => `<th style="padding:4px 4px;text-align:center;font-size:11px;">R${i+1} ST</th><th style="padding:4px 4px;text-align:center;font-size:11px;">R${i+1} OT</th>`).join('')}
              <th style="padding:4px 8px;text-align:center;">Total</th>
            </tr></thead>
            <tbody>
              ${validRows.map(row => {
                const emp = employees.find(e => e.id === row.empId);
                const name = emp ? `${emp.lastName}, ${emp.firstName}` : row.empId;
                const total = row.records.reduce((a, r) => a + r.st + r.ot, 0);
                return `<tr style="border-top:1px solid #bbf7d0;">
                  <td style="padding:4px 8px;white-space:nowrap;"><strong>${name}</strong></td>
                  ${row.records.map(r => `<td style="padding:4px 4px;text-align:center;">${r.st}</td><td style="padding:4px 4px;text-align:center;">${r.ot}</td>`).join('')}
                  <td style="padding:4px 8px;text-align:center;font-weight:600;">${total.toFixed(1)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    } else {
      html += `<div style="padding:16px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;text-align:center;">
        <strong style="color:#92400e;">No valid rows to import.</strong>
        <p style="font-size:13px;color:#78350f;margin-top:4px;">Make sure Employee IDs in the CSV match the crew members on this timesheet.</p>
      </div>`;
    }

    // Store for confirm step (include meta)
    pendingImportData = { tsId, validRows, meta };

    // Show step 2
    document.getElementById('import-step-1').style.display = 'none';
    document.getElementById('import-step-2').style.display = 'block';
    document.getElementById('import-step-2').innerHTML = `
      <h3 style="margin-bottom:12px;">Import Preview — ${ts.timesheetNumber}</h3>
      <p style="font-size:13px;color:var(--gray-600);margin-bottom:12px;">
        ${getProjectName(ts.projectId)} &mdash; ${formatDate(ts.date)} (${ts.day})
      </p>
      ${html}
    `;

    document.getElementById('import-next-btn').style.display = 'none';
    if (validRows.length > 0 || hasMetaChanges) {
      document.getElementById('import-confirm-btn').style.display = '';
    }
    document.getElementById('import-back-btn').style.display = '';
  };

  reader.readAsText(fileInput.files[0]);
}

function importGoBack() {
  document.getElementById('import-step-1').style.display = 'block';
  document.getElementById('import-step-2').style.display = 'none';
  document.getElementById('import-next-btn').style.display = '';
  document.getElementById('import-confirm-btn').style.display = 'none';
  document.getElementById('import-back-btn').style.display = 'none';
  pendingImportData = null;
}

function confirmImport() {
  if (!pendingImportData) return;

  const fieldTS = DB.getFieldTimesheets();
  const ts = fieldTS.find(t => t.id === pendingImportData.tsId);
  if (!ts) return toast('Timesheet not found', 'error');

  const meta = pendingImportData.meta;

  // Apply record-level attributes (only update non-empty values from CSV)
  if (meta) {
    if (!ts.recordAreas) ts.recordAreas = Array(6).fill('');
    if (!ts.recordTaskCodes) ts.recordTaskCodes = Array(6).fill('');
    if (!ts.recordCWPs) ts.recordCWPs = Array(6).fill('');
    if (!ts.recordFCOs) ts.recordFCOs = Array(6).fill('');

    meta.areas.forEach((v, i) => { if (v) ts.recordAreas[i] = v; });
    meta.taskCodes.forEach((v, i) => { if (v) ts.recordTaskCodes[i] = v; });
    meta.cwps.forEach((v, i) => { if (v) ts.recordCWPs[i] = v; });
    meta.fcos.forEach((v, i) => { if (v) ts.recordFCOs[i] = v; });
  }

  // Apply employee hours
  let updatedCount = 0;
  pendingImportData.validRows.forEach(row => {
    const entry = ts.crewEntries.find(c => c.empId === row.empId);
    if (entry) {
      entry.records = row.records.map(r => ({ st: r.st, ot: r.ot }));
      updatedCount++;
    }
  });

  DB.setFieldTimesheets(fieldTS);
  pendingImportData = null;
  closeModal();
  navigate('admin-timesheets');
  toast(`Imported: ${updatedCount} employee(s) + record attributes updated`);
}

// --- Init on load ---
document.addEventListener('DOMContentLoaded', initApp);
