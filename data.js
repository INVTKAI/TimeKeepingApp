// ============================================================
// DATA LAYER - Simulates JSON file storage via localStorage
// Structured for easy swap to API/file-based backend later
// ============================================================

const DB = {
  _get(key) {
    const raw = localStorage.getItem(`tk_${key}`);
    return raw ? JSON.parse(raw) : null;
  },
  _set(key, val) {
    localStorage.setItem(`tk_${key}`, JSON.stringify(val));
  },

  // --- Users ---
  getUsers() { return this._get('users') || []; },
  setUsers(u) { this._set('users', u); },

  // --- Employees ---
  getEmployees() { return this._get('employees') || []; },
  setEmployees(e) { this._set('employees', e); },

  // --- Projects ---
  getProjects() { return this._get('projects') || []; },
  setProjects(p) { this._set('projects', p); },

  // --- Task Codes ---
  getTaskCodes() { return this._get('taskCodes') || []; },
  setTaskCodes(t) { this._set('taskCodes', t); },

  // --- Areas ---
  getAreas() { return this._get('areas') || []; },
  setAreas(a) { this._set('areas', a); },

  // --- CWP ---
  getCWPs() { return this._get('cwps') || []; },
  setCWPs(c) { this._set('cwps', c); },

  // --- FCO/PCR ---
  getFCOs() { return this._get('fcos') || []; },
  setFCOs(f) { this._set('fcos', f); },

  // --- Staff Timesheets ---
  getStaffTimesheets() { return this._get('staffTimesheets') || []; },
  setStaffTimesheets(t) { this._set('staffTimesheets', t); },

  // --- Field Timesheets ---
  getFieldTimesheets() { return this._get('fieldTimesheets') || []; },
  setFieldTimesheets(t) { this._set('fieldTimesheets', t); },

  // --- Badge Records (simulated) ---
  getBadgeRecords() { return this._get('badgeRecords') || []; },
  setBadgeRecords(b) { this._set('badgeRecords', b); },

  // --- Export all data as JSON ---
  exportAll() {
    const keys = ['users','employees','projects','taskCodes','areas','fcos','staffTimesheets','fieldTimesheets','badgeRecords'];
    const data = {};
    keys.forEach(k => { data[k] = this._get(k) || []; });
    return data;
  },

  // --- Import from JSON ---
  importAll(data) {
    Object.keys(data).forEach(k => this._set(k, data[k]));
  },

  // --- Clear all ---
  clearAll() {
    Object.keys(localStorage).filter(k => k.startsWith('tk_')).forEach(k => localStorage.removeItem(k));
  }
};

// ============================================================
// SEED DATA - Populates initial sample data
// ============================================================
function seedData() {
  if (DB._get('seeded')) return;

  // Users (auth)
  DB.setUsers([
    { id: 'U001', username: 'admin', password: 'admin123', role: 'admin', name: 'System Admin', empId: null },
    { id: 'U002', username: 'jsmith', password: 'pass123', role: 'staff', name: 'John Smith', empId: 'E001' },
    { id: 'U003', username: 'mjones', password: 'pass123', role: 'staff', name: 'Mary Jones', empId: 'E002' },
    { id: 'U004', username: 'tkwright', password: 'pass123', role: 'timekeeper', name: 'Tom Wright', empId: 'E010' },
    { id: 'U005', username: 'bwilson', password: 'pass123', role: 'staff', name: 'Bob Wilson', empId: 'E003' },
  ]);

  // Employees
  DB.setEmployees([
    { id: 'E001', firstName: 'John', lastName: 'Smith', type: 'staff', craft: 'Engineer', active: true },
    { id: 'E002', firstName: 'Mary', lastName: 'Jones', type: 'staff', craft: 'Designer', active: true },
    { id: 'E003', firstName: 'Bob', lastName: 'Wilson', type: 'staff', craft: 'Project Manager', active: true },
    { id: 'E004', firstName: 'Carlos', lastName: 'Garcia', type: 'field', craft: 'Pipefitter', active: true },
    { id: 'E005', firstName: 'David', lastName: 'Lee', type: 'field', craft: 'Welder', active: true },
    { id: 'E006', firstName: 'James', lastName: 'Brown', type: 'field', craft: 'Electrician', active: true },
    { id: 'E007', firstName: 'Mike', lastName: 'Davis', type: 'field', craft: 'Ironworker', active: true },
    { id: 'E008', firstName: 'Steve', lastName: 'Martinez', type: 'field', craft: 'Pipefitter', active: true },
    { id: 'E009', firstName: 'Kevin', lastName: 'Taylor', type: 'field', craft: 'Welder', active: true },
    { id: 'E010', firstName: 'Tom', lastName: 'Wright', type: 'field', craft: 'Foreman', active: true },
    { id: 'E011', firstName: 'Rick', lastName: 'Anderson', type: 'field', craft: 'Electrician', active: true },
    { id: 'E012', firstName: 'Paul', lastName: 'Thomas', type: 'field', craft: 'Laborer', active: true },
  ]);

  // Projects
  DB.setProjects([
    { id: 'P001', name: 'Refinery Turnaround', number: '2024-001', active: true },
    { id: 'P002', name: 'Pipeline Extension', number: '2024-002', active: true },
    { id: 'P003', name: 'Tank Farm Upgrade', number: '2024-003', active: true },
    { id: 'P004', name: 'Office Renovation', number: '2024-004', active: true },
  ]);

  // Areas
  DB.setAreas([
    { id: 'A001', code: 'UNIT-1', name: 'Unit 1', projectId: 'P001' },
    { id: 'A002', code: 'UNIT-2', name: 'Unit 2', projectId: 'P001' },
    { id: 'A003', code: 'SEC-A', name: 'Section A', projectId: 'P002' },
    { id: 'A004', code: 'SEC-B', name: 'Section B', projectId: 'P002' },
    { id: 'A005', code: 'TANK-1', name: 'Tank 1', projectId: 'P003' },
    { id: 'A006', code: 'FLOOR-1', name: 'First Floor', projectId: 'P004' },
  ]);

  // Task Codes
  DB.setTaskCodes([
    { id: 'T001', code: 'INST', name: 'Installation' },
    { id: 'T002', code: 'FAB', name: 'Fabrication' },
    { id: 'T003', code: 'WELD', name: 'Welding' },
    { id: 'T004', code: 'ELEC', name: 'Electrical' },
    { id: 'T005', code: 'INSP', name: 'Inspection' },
    { id: 'T006', code: 'ENGR', name: 'Engineering' },
    { id: 'T007', code: 'PROJ', name: 'Project Management' },
    { id: 'T008', code: 'DSGN', name: 'Design' },
    { id: 'T009', code: 'ADMN', name: 'Administrative' },
  ]);

  // CWPs
  DB.setCWPs([
    { id: 'CW001', code: 'CWP-001', description: 'Pipe Rack Installation' },
    { id: 'CW002', code: 'CWP-002', description: 'Foundation Work - Area A' },
    { id: 'CW003', code: 'CWP-003', description: 'Electrical Conduit Run' },
    { id: 'CW004', code: 'CWP-004', description: 'Structural Steel Erection' },
  ]);

  // FCOs
  DB.setFCOs([
    { id: 'F001', code: 'FCO-101', description: 'Change Order - Piping Reroute' },
    { id: 'F002', code: 'FCO-102', description: 'Change Order - Additional Welds' },
    { id: 'F003', code: 'PCR-201', description: 'Project Change Request - Scope Add' },
  ]);

  // Sample Badge Records (simulated clock-in/out from badge system)
  DB.setBadgeRecords([
    { empId: 'E004', date: '2024-04-08', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E005', date: '2024-04-08', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E006', date: '2024-04-08', clockIn: '06:00', clockOut: '15:00', source: 'badge' },
    { empId: 'E007', date: '2024-04-08', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E008', date: '2024-04-08', clockIn: '06:00', clockOut: '16:00', source: 'badge' },
    { empId: 'E009', date: '2024-04-08', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E010', date: '2024-04-08', clockIn: '05:30', clockOut: '15:00', source: 'badge' },
    { empId: 'E011', date: '2024-04-08', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E012', date: '2024-04-08', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E004', date: '2024-04-09', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E005', date: '2024-04-09', clockIn: '06:00', clockOut: '16:00', source: 'badge' },
    { empId: 'E006', date: '2024-04-09', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E007', date: '2024-04-09', clockIn: '06:00', clockOut: '14:30', source: 'badge' },
    { empId: 'E010', date: '2024-04-09', clockIn: '05:30', clockOut: '15:00', source: 'badge' },
  ]);

  // Sample Field Timesheets (pre-created by admin)
  DB.setFieldTimesheets([
    {
      id: 'FT001',
      timesheetNumber: 'TS-2024-0001',
      projectId: 'P001',
      areaCode: 'UNIT-1',
      taskCode: 'INST',
      fco: '',
      foreman: 'E010',
      day: 'Monday',
      date: '2024-04-08',
      status: 'open',
      crewEntries: [
        { empId: 'E004', records: [{st:4,ot:0},{st:2,ot:0},{st:1,ot:0},{st:1,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E005', records: [{st:4,ot:0},{st:2,ot:0},{st:1.5,ot:0},{st:1,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E007', records: [{st:4,ot:0},{st:2,ot:0},{st:1,ot:0},{st:1,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E008', records: [{st:4,ot:0},{st:2,ot:0},{st:2,ot:0},{st:1.5,ot:0},{st:0.5,ot:0},{st:0,ot:0}] },
        { empId: 'E012', records: [{st:4,ot:0},{st:2,ot:0},{st:1,ot:0},{st:1,ot:0},{st:0,ot:0},{st:0,ot:0}] },
      ]
    },
    {
      id: 'FT002',
      timesheetNumber: 'TS-2024-0002',
      projectId: 'P001',
      areaCode: 'UNIT-2',
      taskCode: 'WELD',
      fco: '',
      foreman: 'E010',
      day: 'Monday',
      date: '2024-04-08',
      status: 'open',
      crewEntries: [
        { empId: 'E005', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E009', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E006', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E011', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
      ]
    },
    {
      id: 'FT003',
      timesheetNumber: 'TS-2024-0003',
      projectId: 'P002',
      areaCode: 'SEC-A',
      taskCode: 'FAB',
      fco: 'FCO-101',
      foreman: 'E010',
      day: 'Tuesday',
      date: '2024-04-09',
      status: 'open',
      crewEntries: [
        { empId: 'E004', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E005', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E006', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
        { empId: 'E007', records: [{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0},{st:0,ot:0}] },
      ]
    },
  ]);

  // Sample Staff Timesheets
  DB.setStaffTimesheets([
    {
      id: 'ST001',
      empId: 'E001',
      weekStarting: '2024-04-08',
      status: 'draft',
      lines: [
        { projectId: 'P001', area: 'UNIT-1', taskCode: 'ENGR', fco: '', comment: '', hours: { mon: {st:8,ot:0}, tue: {st:8,ot:0}, wed: {st:8,ot:0}, thu: {st:8,ot:0}, fri: {st:8,ot:0}, sat: {st:0,ot:0}, sun: {st:0,ot:0} } },
      ]
    },
    {
      id: 'ST002',
      empId: 'E002',
      weekStarting: '2024-04-08',
      status: 'draft',
      lines: [
        { projectId: 'P001', area: 'UNIT-1', taskCode: 'DSGN', fco: '', comment: '', hours: { mon: {st:4,ot:0}, tue: {st:4,ot:0}, wed: {st:8,ot:0}, thu: {st:4,ot:0}, fri: {st:4,ot:0}, sat: {st:0,ot:0}, sun: {st:0,ot:0} } },
        { projectId: 'P004', area: 'FLOOR-1', taskCode: 'DSGN', fco: '', comment: '', hours: { mon: {st:4,ot:0}, tue: {st:4,ot:0}, wed: {st:0,ot:0}, thu: {st:4,ot:0}, fri: {st:4,ot:0}, sat: {st:0,ot:0}, sun: {st:0,ot:0} } },
      ]
    },
  ]);

  DB._set('seeded', true);
}
