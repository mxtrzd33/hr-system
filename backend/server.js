const http = require('http');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 5678);
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'hrdb',
  user: process.env.DB_USER || 'hruser',
  password: process.env.DB_PASSWORD || 'hrpass_demo'
});

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Размер запроса слишком большой'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cleanEmployee(body) {
  const full_name = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const position = typeof body.position === 'string' ? body.position.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  const status = typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'Активен';
  const hire_date = typeof body.hire_date === 'string' && body.hire_date.trim() ? body.hire_date.trim() : null;

  if (!full_name || !position || !department) {
    return { error: 'Заполните ФИО, должность и отдел.' };
  }
  if (full_name.length > 150 || position.length > 100 || department.length > 100 || status.length > 50) {
    return { error: 'Превышена допустимая длина одного из полей.' };
  }
  if (hire_date && !/^\d{4}-\d{2}-\d{2}$/.test(hire_date)) {
    return { error: 'Дата приёма должна быть в формате ГГГГ-ММ-ДД.' };
  }
  return { employee: { full_name, position, department, status, hire_date } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/health') {
    try {
      await pool.query('SELECT 1');
      return send(res, 200, { status: 'ok', service: 'hr-backend', database: 'connected' });
    } catch (error) {
      console.error('Health check failed:', error.message);
      return send(res, 503, { status: 'error', service: 'hr-backend', database: 'disconnected' });
    }
  }

  if (req.method === 'GET' && path === '/api/employees') {
    try {
      const result = await pool.query(
        'SELECT id, full_name, position, department, status, hire_date FROM employees ORDER BY id'
      );
      return send(res, 200, { employees: result.rows });
    } catch (error) {
      console.error('GET employees failed:', error.message);
      return send(res, 500, { error: 'Не удалось получить список сотрудников.' });
    }
  }

  if (req.method === 'POST' && path === '/api/employees') {
    try {
      const body = await readJson(req);
      const checked = cleanEmployee(body);
      if (checked.error) return send(res, 400, { error: checked.error });
      const e = checked.employee;
      const result = await pool.query(
        `INSERT INTO employees (full_name, position, department, status, hire_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, full_name, position, department, status, hire_date`,
        [e.full_name, e.position, e.department, e.status, e.hire_date]
      );
      return send(res, 201, { employee: result.rows[0] });
    } catch (error) {
      console.error('POST employee failed:', error.message);
      return send(res, 500, { error: 'Не удалось добавить сотрудника.' });
    }
  }

  const employeeMatch = path.match(/^\/api\/employees\/(\d+)$/);
  if (employeeMatch && req.method === 'PUT') {
    const id = Number(employeeMatch[1]);
    try {
      const body = await readJson(req);
      const checked = cleanEmployee(body);
      if (checked.error) return send(res, 400, { error: checked.error });
      const e = checked.employee;
      const result = await pool.query(
        `UPDATE employees
         SET full_name = $1, position = $2, department = $3, status = $4, hire_date = $5
         WHERE id = $6
         RETURNING id, full_name, position, department, status, hire_date`,
        [e.full_name, e.position, e.department, e.status, e.hire_date, id]
      );
      if (!result.rowCount) return send(res, 404, { error: 'Сотрудник не найден.' });
      return send(res, 200, { employee: result.rows[0] });
    } catch (error) {
      console.error('PUT employee failed:', error.message);
      return send(res, 500, { error: 'Не удалось изменить данные сотрудника.' });
    }
  }

  if (employeeMatch && req.method === 'DELETE') {
    const id = Number(employeeMatch[1]);
    try {
      const result = await pool.query(
        'DELETE FROM employees WHERE id = $1 RETURNING id, full_name',
        [id]
      );
      if (!result.rowCount) return send(res, 404, { error: 'Сотрудник не найден.' });
      return send(res, 200, { message: 'Сотрудник удалён.', employee: result.rows[0] });
    } catch (error) {
      console.error('DELETE employee failed:', error.message);
      return send(res, 500, { error: 'Не удалось удалить сотрудника.' });
    }
  }

  return send(res, 404, { error: 'Маршрут не найден.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HR API запущен на порту ${PORT}`);
});

async function shutdown() {
  await pool.end();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
