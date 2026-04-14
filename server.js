require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
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
// CATEGORÍAS
// ════════════════════════════════════════════
app.get('/api/categorias', handler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categorias_productos ORDER BY id');
  res.json(rows);
}));

app.post('/api/categorias', handler(async (req, res) => {
  const { comando, nombre, descripcion } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO categorias_productos (comando, nombre, descripcion) VALUES ($1, $2, $3) RETURNING *',
    [comando, nombre, descripcion || null]
  );
  res.json(rows[0]);
}));

app.put('/api/categorias/:id', handler(async (req, res) => {
  const { comando, nombre, descripcion, activo } = req.body;
  const { rows } = await pool.query(
    'UPDATE categorias_productos SET comando=$1, nombre=$2, descripcion=$3, activo=$4 WHERE id=$5 RETURNING *',
    [comando, nombre, descripcion || null, activo, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/categorias/:id', handler(async (req, res) => {
  await pool.query('DELETE FROM categorias_productos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// PRODUCTOS
// ════════════════════════════════════════════
app.get('/api/productos', handler(async (req, res) => {
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

app.post('/api/productos', handler(async (req, res) => {
  const { comando, categoria_id, nombre, precio_pen, precio_usd, alerta_stock_en, usos_maximos } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO productos (comando, categoria_id, nombre, precio_pen, precio_usd, alerta_stock_en, usos_maximos) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [comando, categoria_id || null, nombre, precio_pen || 0, precio_usd || 0, alerta_stock_en || 10, usos_maximos || 1]
  );
  res.json(rows[0]);
}));

app.put('/api/productos/:id', handler(async (req, res) => {
  const { comando, categoria_id, nombre, precio_pen, precio_usd, alerta_stock_en, usos_maximos, activo } = req.body;
  const { rows } = await pool.query(
    'UPDATE productos SET comando=$1, categoria_id=$2, nombre=$3, precio_pen=$4, precio_usd=$5, alerta_stock_en=$6, usos_maximos=$7, activo=$8 WHERE id=$9 RETURNING *',
    [comando, categoria_id || null, nombre, precio_pen || 0, precio_usd || 0, alerta_stock_en || 10, usos_maximos || 1, activo, req.params.id]
  );
  res.json(rows[0]);
}));

app.delete('/api/productos/:id', handler(async (req, res) => {
  await pool.query('DELETE FROM productos WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// CLAVES SERIALES
// ════════════════════════════════════════════
app.get('/api/seriales', handler(async (req, res) => {
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
app.post('/api/seriales/bulk', handler(async (req, res) => {
  const { producto_id, claves_texto } = req.body;
  const claves = claves_texto.split('\n').map(c => c.trim()).filter(c => c.length > 0);
  if (claves.length === 0) return res.status(400).json({ error: 'No hay claves para insertar' });
  let insertadas = 0;
  for (const clave of claves) {
    await pool.query(
      "INSERT INTO claves_seriales (producto_id, clave, estado) VALUES ($1,$2,'disponible')",
      [producto_id, clave]
    );
    insertadas++;
  }
  res.json({ insertadas });
}));

app.post('/api/seriales', handler(async (req, res) => {
  const { producto_id, clave } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO claves_seriales (producto_id, clave, estado) VALUES ($1,$2,'disponible') RETURNING *",
    [producto_id, clave]
  );
  res.json(rows[0]);
}));

app.delete('/api/seriales/:id', handler(async (req, res) => {
  await pool.query('DELETE FROM claves_seriales WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════
// TÉCNICOS
// ════════════════════════════════════════════
app.get('/api/tecnicos', handler(async (req, res) => {
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

app.post('/api/tecnicos', handler(async (req, res) => {
  const { telefono, nombre, saldo_usdt } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO tecnicos (telefono, nombre, saldo_usdt) VALUES ($1,$2,$3) RETURNING *',
    [telefono, nombre || null, saldo_usdt || 0]
  );
  res.json(rows[0]);
}));

app.put('/api/tecnicos/:id', handler(async (req, res) => {
  const { nombre, telefono } = req.body;
  const { rows } = await pool.query(
    'UPDATE tecnicos SET nombre=$1, telefono=$2 WHERE id=$3 RETURNING *',
    [nombre || null, telefono, req.params.id]
  );
  res.json(rows[0]);
}));

app.put('/api/tecnicos/:id/saldo', handler(async (req, res) => {
  const { saldo_usdt } = req.body;
  const { rows } = await pool.query(
    'UPDATE tecnicos SET saldo_usdt=$1 WHERE id=$2 RETURNING *',
    [saldo_usdt, req.params.id]
  );
  res.json(rows[0]);
}));

app.put('/api/tecnicos/:id/estado', handler(async (req, res) => {
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
app.get('/api/stock', handler(async (req, res) => {
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
app.get('/api/pagos/resumen', handler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      t.id AS tecnico_id,
      t.nombre AS tecnico_nombre,
      t.telefono,
      COUNT(p.id)                                                        AS total_pedidos,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'descontado')               AS pedidos_pagados,
      COUNT(p.id) FILTER (WHERE p.estado_pago = 'pendiente')               AS pedidos_pendientes,
      COALESCE(SUM(p.precio_usd) FILTER (WHERE p.estado_pago = 'descontado'), 0)    AS total_pagado_usd,
      COALESCE(SUM(p.precio_pen) FILTER (WHERE p.estado_pago = 'descontado'), 0)    AS total_pagado_pen,
      COALESCE(SUM(p.precio_usd) FILTER (WHERE p.estado_pago = 'pendiente'), 0)     AS deuda_usd,
      COALESCE(SUM(p.precio_pen) FILTER (WHERE p.estado_pago = 'pendiente'), 0)     AS deuda_pen,
      COALESCE(SUM(p.precio_usd), 0) AS total_usd,
      COALESCE(SUM(p.precio_pen), 0) AS total_pen
    FROM tecnicos t
    LEFT JOIN pedidos p ON p.tecnico_id = t.id
    GROUP BY t.id, t.nombre, t.telefono
    ORDER BY total_pagado_usd DESC
  `);
  res.json(rows);
}));

app.get('/api/pagos/detalle', handler(async (req, res) => {
  const { tecnico_id, estado_pago } = req.query;
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
  if (tecnico_id)   { params.push(tecnico_id);   query += ` AND p.tecnico_id = $${params.length}`; }
  if (estado_pago)  { params.push(estado_pago);  query += ` AND p.estado_pago = $${params.length}`; }
  query += ' ORDER BY p.id DESC LIMIT 500';
  const { rows } = await pool.query(query, params);
  res.json(rows);
}));

// ════════════════════════════════════════════
// ACTIVACIONES ESET
// ════════════════════════════════════════════
app.get('/api/activaciones/eset', handler(async (req, res) => {
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

app.get('/api/activaciones/eset/resumen', handler(async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Panel corriendo en http://localhost:${PORT}`));
