require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'cambiar-este-secreto-en-produccion';
const JWT_EXPIRES = '8h';

const app = express();
app.use(cors());
app.use(express.json());

// Archivos estáticos públicos: solo login.html y sus assets
app.use('/login.html', express.static(path.join(__dirname, 'login.html')));

// Middleware de autenticación JWT
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// Sirve index.html solo si tiene token válido (verificado en cliente)
// El panel protege sus llamadas API con requireAuth
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.connect()
  .then(() => console.log('✅ Conectado a PostgreSQL'))
  .catch(e => console.error('❌ Error al conectar a PostgreSQL:', e.message));

// Helper para manejar errores en rutas
const handler = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
};

// ════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════
app.post('/api/auth/login', handler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Credenciales requeridas' });
  const { rows } = await pool.query(
    'SELECT * FROM admin_usuarios WHERE username=$1 AND activo=true', [username]
  );
  if (!rows.length) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  await pool.query('UPDATE admin_usuarios SET last_login=NOW() WHERE id=$1', [user.id]);
  const token = jwt.sign({ id: user.id, username: user.username, nombre: user.nombre }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res.json({ token, nombre: user.nombre, username: user.username });
}));

app.get('/api/auth/me', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, nombre, last_login FROM admin_usuarios WHERE id=$1', [req.user.id]);
  res.json(rows[0] || {});
}));

// CRUD usuarios (solo admins autenticados)
app.get('/api/usuarios', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, nombre, activo, created_at, last_login FROM admin_usuarios ORDER BY id');
  res.json(rows);
}));

app.post('/api/usuarios', requireAuth, handler(async (req, res) => {
  const { username, password, nombre } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO admin_usuarios (username, password, nombre) VALUES ($1,$2,$3) RETURNING id, username, nombre, activo, created_at',
    [username, hash, nombre || null]
  );
  res.json(rows[0]);
}));

app.put('/api/usuarios/:id', requireAuth, handler(async (req, res) => {
  const { nombre, activo, password } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'UPDATE admin_usuarios SET nombre=$1, activo=$2, password=$3 WHERE id=$4 RETURNING id, username, nombre, activo',
      [nombre || null, activo, hash, req.params.id]
    );
    return res.json(rows[0]);
  }
  const { rows } = await pool.query(
    'UPDATE admin_usuarios SET nombre=$1, activo=$2 WHERE id=$3 RETURNING id, username, nombre, activo',
    [nombre || null, activo, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/usuarios/:id', requireAuth, handler(async (req, res) => {
  if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  await pool.query('DELETE FROM admin_usuarios WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// CATEGORÍAS
// ════════════════════════════════════════════
app.get('/api/categorias', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categorias_productos ORDER BY id');
  res.json(rows);
}));

app.post('/api/categorias', requireAuth, handler(async (req, res) => {
  const { comando, nombre, descripcion } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO categorias_productos (comando, nombre, descripcion) VALUES ($1, $2, $3) RETURNING *',
    [comando, nombre, descripcion || null]
  );
  res.json(rows[0]);
}));

app.put('/api/categorias/:id', requireAuth, handler(async (req, res) => {
  const { comando, nombre, descripcion, activo } = req.body;
  const { rows } = await pool.query(
    'UPDATE categorias_productos SET comando=$1, nombre=$2, descripcion=$3, activo=$4 WHERE id=$5 RETURNING *',
    [comando, nombre, descripcion || null, activo, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/categorias/:id', requireAuth, handler(async (req, res) => {
  await pool.query('DELETE FROM categorias_productos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// PRODUCTOS
// ════════════════════════════════════════════
app.get('/api/productos', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, c.nombre AS categoria_nombre,
      COALESCE((
        SELECT SUM(p2.usos_maximos - cs.usos_actuales)
        FROM claves_seriales cs
        JOIN productos p2 ON p2.id = cs.producto_id
        WHERE cs.producto_id = p.id AND cs.estado = 'disponible'
      ), 0) AS stock
    FROM productos p
    LEFT JOIN categorias_productos c ON c.id = p.categoria_id
    ORDER BY p.id
  `);
  res.json(rows);
}));

app.post('/api/productos', requireAuth, handler(async (req, res) => {
  const { comando, categoria_id, nombre, precio_pen, precio_usd, alerta_stock_en, usos_maximos, link_instalador } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO productos (comando, categoria_id, nombre, precio_pen, precio_usd, alerta_stock_en, usos_maximos, link_instalador) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [comando, categoria_id || null, nombre, precio_pen || 0, precio_usd || 0, alerta_stock_en || 10, usos_maximos || 1, link_instalador || null]
  );
  res.json(rows[0]);
}));

app.put('/api/productos/:id', requireAuth, handler(async (req, res) => {
  const { comando, categoria_id, nombre, precio_pen, precio_usd, alerta_stock_en, usos_maximos, activo, link_instalador } = req.body;
  const { rows } = await pool.query(
    'UPDATE productos SET comando=$1, categoria_id=$2, nombre=$3, precio_pen=$4, precio_usd=$5, alerta_stock_en=$6, usos_maximos=$7, activo=$8, link_instalador=$9 WHERE id=$10 RETURNING *',
    [comando, categoria_id || null, nombre, precio_pen || 0, precio_usd || 0, alerta_stock_en || 10, usos_maximos || 1, activo, link_instalador || null, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/productos/:id', requireAuth, handler(async (req, res) => {
  await pool.query('DELETE FROM productos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// CLAVES SERIALES
// ════════════════════════════════════════════
app.get('/api/seriales', requireAuth, handler(async (req, res) => {
  const { producto_id, estado } = req.query;
  let query = `
    SELECT cs.*, p.nombre AS producto_nombre, t.nombre AS tecnico_nombre
    FROM claves_seriales cs
    LEFT JOIN productos p ON p.id = cs.producto_id
    LEFT JOIN tecnicos t ON t.id = cs.entregada_a
    WHERE 1=1
  `;
  const params = [];
  if (producto_id) { params.push(producto_id); query += ` AND cs.producto_id = $${params.length}`; }
  if (estado)      { params.push(estado);      query += ` AND cs.estado = $${params.length}`; }
  query += ' ORDER BY cs.id DESC LIMIT 200';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

// IMPORTANTE: bulk debe ir ANTES que /:id para que Express no confunda "bulk" con un id
app.post('/api/seriales/bulk', requireAuth, handler(async (req, res) => {
  const { producto_id, claves_texto, caducidad, id_eset } = req.body;
  const claves = claves_texto.split('\n').map(c => c.trim()).filter(c => c.length > 0);
  if (claves.length === 0) return res.status(400).json({ error: 'No hay claves para insertar' });
  let insertadas = 0;
  for (const clave of claves) {
    await pool.query(
      "INSERT INTO claves_seriales (producto_id, clave, estado, caducidad, id_eset) VALUES ($1,$2,'disponible',$3,$4)",
      [producto_id, clave, caducidad || null, id_eset || null]
    );
    insertadas++;
  }
  res.json({ insertadas });
}));

app.post('/api/seriales', requireAuth, handler(async (req, res) => {
  const { producto_id, clave } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO claves_seriales (producto_id, clave, estado) VALUES ($1,$2,'disponible') RETURNING *",
    [producto_id, clave]
  );
  res.json(rows[0]);
}));

app.put('/api/seriales/:id', requireAuth, handler(async (req, res) => {
  const { estado } = req.body;
  const allowed = ['disponible', 'entregada', 'expirada'];
  if (!allowed.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const { rows } = await pool.query(
    'UPDATE claves_seriales SET estado=$1 WHERE id=$2 RETURNING *',
    [estado, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Serial no encontrada' });
  res.json(rows[0]);
}));

app.delete('/api/seriales/:id', requireAuth, handler(async (req, res) => {
  await pool.query('DELETE FROM claves_seriales WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// TÉCNICOS
// ════════════════════════════════════════════
app.get('/api/tecnicos', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.*,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'pendiente') AS pedidos_pendientes,
      COALESCE(SUM(p.precio_usd) FILTER (WHERE p.estado_pago = 'pendiente'), 0) AS deuda_usd,
      COALESCE(SUM(p.precio_pen) FILTER (WHERE p.estado_pago = 'pendiente'), 0) AS deuda_pen
    FROM tecnicos t
    LEFT JOIN pedidos p ON p.tecnico_id = t.id
    GROUP BY t.id
    ORDER BY t.nombre
  `);
  res.json(rows);
}));

app.post('/api/tecnicos', requireAuth, handler(async (req, res) => {
  const { telefono, nombre, saldo_usdt } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO tecnicos (telefono, nombre, saldo_usdt) VALUES ($1,$2,$3) RETURNING *',
    [telefono, nombre || null, saldo_usdt || 0]
  );
  res.json(rows[0]);
}));

app.put('/api/tecnicos/:id', requireAuth, handler(async (req, res) => {
  const { nombre, telefono } = req.body;
  const { rows } = await pool.query(
    'UPDATE tecnicos SET nombre=$1, telefono=$2 WHERE id=$3 RETURNING *',
    [nombre || null, telefono, req.params.id]
  );
  res.json(rows[0]);
}));

app.put('/api/tecnicos/:id/saldo', requireAuth, handler(async (req, res) => {
  const { saldo_usdt } = req.body;
  const { rows } = await pool.query(
    'UPDATE tecnicos SET saldo_usdt=$1 WHERE id=$2 RETURNING *',
    [saldo_usdt, req.params.id]
  );
  res.json(rows[0]);
}));

app.put('/api/tecnicos/:id/estado', requireAuth, handler(async (req, res) => {
  const { estado } = req.body;
  const { rows } = await pool.query(
    'UPDATE tecnicos SET estado=$1 WHERE id=$2 RETURNING *',
    [estado, req.params.id]
  );
  res.json(rows[0]);
}));

// ════════════════════════════════════════════
// STOCK RESUMEN
// ════════════════════════════════════════════
app.get('/api/stock', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id, p.nombre, p.comando, p.alerta_stock_en, p.usos_maximos,
      COALESCE(SUM(p.usos_maximos - cs.usos_actuales) FILTER (WHERE cs.estado = 'disponible'), 0) AS disponibles,
      COUNT(cs.id) FILTER (WHERE cs.estado = 'entregada')   AS entregadas,
      COUNT(cs.id) FILTER (WHERE cs.estado = 'expirada')    AS expiradas,
      COUNT(cs.id) FILTER (WHERE cs.estado = 'disponible')  AS seriales_activos
    FROM productos p
    LEFT JOIN claves_seriales cs ON cs.producto_id = p.id
    WHERE p.activo = true
    GROUP BY p.id ORDER BY disponibles ASC
  `);
  res.json(rows);
}));

// ════════════════════════════════════════════
// PAGOS (pedidos agrupados por técnico)
// ════════════════════════════════════════════
app.get('/api/pagos/resumen', requireAuth, handler(async (req, res) => {
  const { desde, hasta } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (desde) { params.push(desde); where += ` AND ( p.fecha_pedido AT TIME ZONE 'America/Lima' )::date >= $${params.length}::date`; }
  if (hasta) { params.push(hasta); where += ` AND ( p.fecha_pedido AT TIME ZONE 'America/Lima' )::date <= $${params.length}::date`; }

  const { rows } = await pool.query(`
    SELECT
      t.id AS tecnico_id,
      t.nombre AS tecnico_nombre,
      t.telefono,
      COUNT(p.id)                                                                AS total_pedidos,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'descontado')                    AS pedidos_pagados,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'pendiente')                     AS pedidos_pendientes,
      COALESCE(SUM(p.precio_usd) FILTER (WHERE p.estado_pago = 'descontado'), 0) AS total_pagado_usd,
      COALESCE(SUM(p.precio_pen) FILTER (WHERE p.estado_pago = 'descontado'), 0) AS total_pagado_pen,
      COALESCE(SUM(p.precio_usd) FILTER (WHERE p.estado_pago = 'pendiente'), 0)  AS deuda_usd,
      COALESCE(SUM(p.precio_pen) FILTER (WHERE p.estado_pago = 'pendiente'), 0)  AS deuda_pen,
      COALESCE(SUM(p.precio_usd), 0) AS total_usd,
      COALESCE(SUM(p.precio_pen), 0) AS total_pen
    FROM tecnicos t
    JOIN pedidos p ON p.tecnico_id = t.id
    ${where}
    GROUP BY t.id, t.nombre, t.telefono
    ORDER BY total_pagado_usd DESC
  `, params);
  res.json(rows);
}));

app.get('/api/pagos/detalle', requireAuth, handler(async (req, res) => {
  const { tecnico_id, estado_pago, desde, hasta } = req.query;
  let query = `
    SELECT
      p.*,
      t.nombre AS tecnico_nombre,
      t.telefono AS tecnico_telefono,
      pr.nombre AS producto_nombre,
      pr.comando AS producto_comando
    FROM pedidos p
    LEFT JOIN tecnicos t ON t.id = p.tecnico_id
    LEFT JOIN productos pr ON pr.id = p.producto_id
    WHERE 1=1
  `;
  const params = [];
  if (tecnico_id)  { params.push(tecnico_id);  query += ` AND p.tecnico_id = $${params.length}`; }
  if (estado_pago) { params.push(estado_pago); query += ` AND p.estado_pago = $${params.length}`; }
  if (desde)       { params.push(desde);       query += ` AND (p.fecha_pedido AT TIME ZONE 'America/Lima')::date >= $${params.length}::date`; }
  if (hasta)       { params.push(hasta);       query += ` AND (p.fecha_pedido AT TIME ZONE 'America/Lima')::date <= $${params.length}::date`; }
  query += ' ORDER BY p.id DESC LIMIT 500';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

// ════════════════════════════════════════════
// ACTIVACIONES ESET
// ════════════════════════════════════════════
app.get('/api/activaciones/eset', requireAuth, handler(async (req, res) => {
  const { tecnico_id, estado } = req.query;
  let query = `
    SELECT
      p.*,
      t.nombre AS tecnico_nombre,
      t.telefono AS tecnico_telefono,
      pr.nombre AS producto_nombre,
      pr.comando AS producto_comando
    FROM pedidos p
    LEFT JOIN tecnicos t ON t.id = p.tecnico_id
    LEFT JOIN productos pr ON pr.id = p.producto_id
    WHERE (LOWER(pr.nombre) LIKE '%eset%' OR LOWER(pr.comando) LIKE '%eset%')
  `;
  const params = [];
  if (tecnico_id) { params.push(tecnico_id); query += ` AND p.tecnico_id = $${params.length}`; }
  if (estado)     { params.push(estado);     query += ` AND p.estado_pago = $${params.length}`; }
  query += ' ORDER BY p.id DESC LIMIT 500';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

app.get('/api/activaciones/eset/resumen', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      t.id AS tecnico_id,
      t.nombre AS tecnico_nombre,
      pr.nombre AS producto_nombre,
      pr.comando AS producto_comando,
      COUNT(p.id) AS total_activaciones,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'descontado') AS pagadas,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'pendiente') AS pendientes,
      COALESCE(SUM(p.precio_usd), 0) AS total_usd,
      COALESCE(SUM(p.precio_pen), 0) AS total_pen
    FROM pedidos p
    LEFT JOIN tecnicos t ON t.id = p.tecnico_id
    LEFT JOIN productos pr ON pr.id = p.producto_id
    WHERE (LOWER(pr.nombre) LIKE '%eset%' OR LOWER(pr.comando) LIKE '%eset%')
    GROUP BY t.id, t.nombre, pr.nombre, pr.comando
    ORDER BY total_activaciones DESC
  `);
  res.json(rows);
}));

// ════════════════════════════════════════════
// LICENCIAS ACTIVADAS (tabla activaciones_eset)
// ════════════════════════════════════════════
app.get('/api/activaciones-eset', requireAuth, handler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      ae.id, ae.clave_id, ae.tecnico_id, ae.id_publico, ae.nombre_equipo,
      ae.nombre_cliente, ae.url_captura, ae.numero_activacion,
      ae.fecha_activacion, ae.nombre_puesto, ae.nombre_dispositivo,
      t.nombre AS tecnico_nombre,
      cs.clave AS serial_key
    FROM activaciones_eset ae
    LEFT JOIN tecnicos t ON t.id = ae.tecnico_id
    LEFT JOIN claves_seriales cs ON cs.id = ae.clave_id
    ORDER BY ae.id DESC
  `);
  res.json(rows);
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Panel corriendo en http://localhost:${PORT}`));
