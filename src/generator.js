const sql = require('mssql');
const logger = require('./logger');

async function hasEnabledTriggers(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM sys.triggers tr
      JOIN sys.tables t ON tr.parent_id = t.object_id
      WHERE tr.is_disabled = 0
        AND t.name = @table
        AND SCHEMA_NAME(t.schema_id) = @schema
    `);
  return (res.recordset[0]?.cnt || 0) > 0;
}

async function getIdentityColumn(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`
      SELECT c.name AS COLUMN_NAME
      FROM sys.identity_columns ic
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      JOIN sys.tables t ON t.object_id = ic.object_id
      WHERE t.name = @table AND SCHEMA_NAME(t.schema_id) = @schema
    `);
  return res.recordset[0]?.COLUMN_NAME || null;
}

function mapSqlTypeToMssqlType(col) {
  const t = col.DATA_TYPE.toLowerCase();
  if (t.includes('char') || t === 'text' || t === 'ntext') {
    return col.CHARACTER_MAXIMUM_LENGTH && col.CHARACTER_MAXIMUM_LENGTH > 0
      ? sql.NVarChar(col.CHARACTER_MAXIMUM_LENGTH)
      : sql.NVarChar(sql.MAX);
  }
  if (t.includes('int')) return sql.Int;
  if (t === 'bigint') return sql.BigInt;
  if (t === 'bit') return sql.Bit;
  if (t.includes('decimal') || t === 'numeric') return sql.Decimal(18, 4);
  if (t.includes('float') || t === 'real') return sql.Float;
  if (t.includes('date') || t.includes('time')) return sql.DateTime;
  if (t === 'uniqueidentifier') return sql.NVarChar(50);
  return sql.NVarChar(sql.MAX);
}

function toOpenApiType(col) {
  const t = col.DATA_TYPE.toLowerCase();
  if (t.includes('int')) return { type: 'integer' };
  if (t === 'bigint') return { type: 'integer', format: 'int64' };
  if (t === 'bit') return { type: 'boolean' };
  if (t.includes('float') || t === 'real' || t.includes('decimal') || t === 'numeric') return { type: 'number' };
  if (t.includes('date') || t.includes('time')) return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

async function discoverObjects(pool, filterSqlLike) {
  const q = `
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE @filter
      AND TABLE_TYPE IN ('BASE TABLE','VIEW')`;
  const request = pool.request();
  request.input('filter', sql.NVarChar, filterSqlLike);
  const res = await request.query(q);
  return res.recordset; // each has schema, name, and type
}


async function getColumns(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
            ORDER BY ORDINAL_POSITION`);
  return res.recordset;
}

async function getPrimaryKey(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('table', sql.NVarChar, table)
    .query(`SELECT k.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
              ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            WHERE t.TABLE_SCHEMA = @schema AND t.TABLE_NAME = @table AND t.CONSTRAINT_TYPE='PRIMARY KEY'`);
  return res.recordset.map(r => r.COLUMN_NAME);
}

function qName(schema, table) {
  return `[${schema}].[${table}]`;
}

function registerRoutes(app, tableMeta, endpoint) {
  const base = `/${endpoint}/${tableMeta.table}`;
  const schema = tableMeta.schema;
  const table = tableMeta.table;
  const pk = tableMeta.pk && tableMeta.pk[0];
  const isView = !!tableMeta.isView;

  if (process.env.DEBUG_ROUTES) {
    logger.info(`[ROUTES] base=${base} isView=${isView} pk=${pk || 'none'}`);
  }
  logger.verbose('Registering routes for', endpoint, table, 'under', base);

  // LIST with optional filters (tables & views), Supabase-style order/limit/offset
  app.get(base, async (req, res) => {
    try {
      const pool = tableMeta.pool;
      const request = pool.request();

      // 1) Column filters
      const where = [];
      for (const col of tableMeta.columns) {
        const v = req.query[col.COLUMN_NAME];
        if (v !== undefined) {
          where.push(`[${col.COLUMN_NAME}] = @${col.COLUMN_NAME}`);
          request.input(col.COLUMN_NAME, mapSqlTypeToMssqlType(col), v);
        }
      }

      // 2) Parse sort & pagination (Supabase/PostgREST)
      //    - order=col.asc | col.desc (default asc)
      //    - limit (default -1) => fetch all
      //    - offset (default 0)
      const q = req.query;

      // order format: "col.asc" or "col.desc"
      let orderCol, orderDir = 'ASC'; // default ASC
      if (q.order) {
        const parts = String(q.order).split('.');
        orderCol = parts[0];
        orderDir = (parts[1] && parts[1].toUpperCase() === 'DESC') ? 'DESC' : 'ASC';
      }

      // choose a safe default if order not provided or invalid
      const columnNames = new Set(tableMeta.columns.map(c => c.COLUMN_NAME));
      const pkColName = tableMeta.pk && tableMeta.pk[0];
      if (!orderCol || !columnNames.has(orderCol)) {
        orderCol = pkColName || tableMeta.columns[0].COLUMN_NAME;
        orderDir = 'ASC';
      }

      // limit default: -1 (all). If >=0 -> apply FETCH.
      let limit = Number.isFinite(parseInt(q.limit, 10)) ? parseInt(q.limit, 10) : -1;
      // offset default: 0
      let offset = Number.isFinite(parseInt(q.offset, 10)) ? parseInt(q.offset, 10) : 0;
      if (offset < 0) offset = 0;

      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const orderSql = `ORDER BY [${orderCol}] ${orderDir}`;

      // 3) Build SQL (SQL Server requires ORDER BY for OFFSET/FETCH)
      let sqlText;
      if (limit < 0 && offset === 0) {
        // no limit, no offset
        sqlText = `SELECT * FROM ${qName(schema, table)} ${whereSql} ${orderSql}`;
      } else if (limit < 0 && offset >= 0) {
        // offset only
        request.input('offset', sql.Int, offset);
        sqlText = `SELECT * FROM ${qName(schema, table)} ${whereSql} ${orderSql} OFFSET @offset ROWS`;
      } else {
        // limit >= 0
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);
        sqlText = `SELECT * FROM ${qName(schema, table)} ${whereSql} ${orderSql} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
      }

      if (process.env.DEBUG_LIST) {
        logger.info(`[LIST] ${base} order=${orderCol}.${orderDir.toLowerCase()} limit=${limit} offset=${offset}`);
      }

      logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
      const result = await request.query(sqlText);
      res.json(result.recordset);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // For tables only (not views), enable PK and write routes when PK exists
  if (!isView && pk) {
    // GET by PK
    app.get(`${base}/:${pk}`, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const col = tableMeta.columns.find(c => c.COLUMN_NAME === pk) || {};
        request.input(pk, mapSqlTypeToMssqlType(col), req.params[pk]);
        const sqlText = `SELECT * FROM ${qName(schema, table)} WHERE [${pk}] = @${pk}`;
        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const result = await request.query(sqlText);
        if (result.recordset.length === 0) return res.status(404).end();
        res.json(result.recordset[0]);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // CREATE
    app.post(base, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const cols = [];
        const vals = [];

        for (const col of tableMeta.columns) {
          if (req.body[col.COLUMN_NAME] !== undefined) {
            cols.push(`[${col.COLUMN_NAME}]`);
            vals.push(`@${col.COLUMN_NAME}`);
            request.input(col.COLUMN_NAME, mapSqlTypeToMssqlType(col), req.body[col.COLUMN_NAME]);
          }
        }

        let sqlText;
        if (tableMeta.hasTriggers) {
          if (tableMeta.identity) {
            // Best path: insert then reselect by SCOPE_IDENTITY on the identity column
            sqlText = `
              SET NOCOUNT ON;
              INSERT INTO ${qName(schema, table)} (${cols.join(',')})
              VALUES (${vals.join(',')});
              DECLARE @id numeric(38,0) = SCOPE_IDENTITY();
              SELECT * FROM ${qName(schema, table)} WHERE [${tableMeta.identity}] = @id;
            `;
          } else if (tableMeta.pk && req.body[tableMeta.pk[0]] !== undefined) {
            // No identity but PK provided in body -> reselect by PK
            sqlText = `
              SET NOCOUNT ON;
              INSERT INTO ${qName(schema, table)} (${cols.join(',')})
              VALUES (${vals.join(',')});
              SELECT * FROM ${qName(schema, table)} WHERE [${tableMeta.pk[0]}] = @${tableMeta.pk[0]};
            `;
          } else {
            // Fallback: create #out without identity using expression on identity (if any)
            const outSelect = tableMeta.columns.map(c => {
              return c.COLUMN_NAME === tableMeta.identity
                ? `t.[${c.COLUMN_NAME}] + 0 AS [${c.COLUMN_NAME}]`
                : `t.[${c.COLUMN_NAME}]`;
            }).join(', ');
            sqlText = `
              SET NOCOUNT ON;
              IF OBJECT_ID('tempdb..#out') IS NOT NULL DROP TABLE #out;
              SELECT TOP 0 ${outSelect} INTO #out FROM ${qName(schema, table)} AS t WHERE 1 = 0;

              INSERT INTO ${qName(schema, table)} (${cols.join(',')})
              OUTPUT inserted.* INTO #out
              VALUES (${vals.join(',')});

              SELECT * FROM #out;
              DROP TABLE #out;
            `;
          }
        } else {
          sqlText = `INSERT INTO ${qName(schema, table)} (${cols.join(',')}) OUTPUT inserted.* VALUES (${vals.join(',')})`;
        }

        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const r = await request.query(sqlText);
        const out = Array.isArray(r.recordsets) && r.recordsets[r.recordsets.length - 1] || r.recordset;
        res.status(201).json(out && out[0] || {});
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // UPDATE by PK
    app.put(`${base}/:${pk}`, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const sets = [];

        for (const col of tableMeta.columns) {
          if (col.COLUMN_NAME === pk) continue;
          if (req.body[col.COLUMN_NAME] !== undefined) {
            sets.push(`[${col.COLUMN_NAME}] = @${col.COLUMN_NAME}`);
            request.input(col.COLUMN_NAME, mapSqlTypeToMssqlType(col), req.body[col.COLUMN_NAME]);
          }
        }

        const pkCol = tableMeta.columns.find(c => c.COLUMN_NAME === pk) || {};
        request.input(pk, mapSqlTypeToMssqlType(pkCol), req.params[pk]);

        if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

        let sqlText;
        if (tableMeta.hasTriggers) {
          sqlText = `
            SET NOCOUNT ON;
            UPDATE ${qName(schema, table)} SET ${sets.join(', ')} WHERE [${pk}] = @${pk};
            SELECT * FROM ${qName(schema, table)} WHERE [${pk}] = @${pk};
          `;
        } else {
          // Original (no triggers)【24-1】
          sqlText = `UPDATE ${qName(schema, table)} SET ${sets.join(', ')} OUTPUT inserted.* WHERE [${pk}] = @${pk}`;
        }

        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const r = await request.query(sqlText);
        const out = Array.isArray(r.recordsets) && r.recordsets[r.recordsets.length - 1] || r.recordset;
        if (!out || out.length === 0) return res.status(404).end();
        res.json(out[0]);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // DELETE by PK
    app.delete(`${base}/:${pk}`, async (req, res) => {
      try {
        const pool = tableMeta.pool;
        const request = pool.request();
        const pkCol = tableMeta.columns.find(c => c.COLUMN_NAME === pk) || {};
        request.input(pk, mapSqlTypeToMssqlType(pkCol), req.params[pk]);

        let sqlText;
        if (tableMeta.hasTriggers) {
          const outSelect = tableMeta.columns.map(c => {
            return c.COLUMN_NAME === tableMeta.identity
              ? `t.[${c.COLUMN_NAME}] + 0 AS [${c.COLUMN_NAME}]`
              : `t.[${c.COLUMN_NAME}]`;
          }).join(', ');
          sqlText = `
            SET NOCOUNT ON;
            IF OBJECT_ID('tempdb..#out') IS NOT NULL DROP TABLE #out;
            SELECT TOP 0 ${outSelect} INTO #out FROM ${qName(schema, table)} AS t WHERE 1 = 0;

            DELETE FROM ${qName(schema, table)}
            OUTPUT deleted.* INTO #out
            WHERE [${pk}] = @${pk};

            SELECT * FROM #out;
            DROP TABLE #out;
          `;
        } else {
          // Original (no triggers)【24-1】
          sqlText = `DELETE FROM ${qName(schema, table)} OUTPUT deleted.* WHERE [${pk}] = @${pk}`;
        }

        logger.verbose('Executing SQL:', sqlText, 'params=', request.parameters);
        const r = await request.query(sqlText);
        const out = Array.isArray(r.recordsets) && r.recordsets[r.recordsets.length - 1] || r.recordset;
        if (!out || out.length === 0) return res.status(404).end();
        res.json(out[0]);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
    
  }
}

async function setupDynamicRoutes(app, pool, endpointConfig) {
  const filter = endpointConfig.filter || '%';
  // convert regex-like ^MI -> MI% for SQL LIKE
  const sqlLike = filter.replace(/^\^/, '').replace(/\$/, '') + '%';

  const endpoint = endpointConfig.endpoint || 'api';

  if (process.env.DEBUG_DISCOVERY) {
    logger.info(`[DISCOVERY] endpoint=${endpoint} filter='${filter}' like='${sqlLike}'`);
  }

  // FIX: initialize accumulator
  const openApiSchemas = {};

  // discover tables + views
  const objects = await discoverObjects(pool, sqlLike);

  for (const t of objects) {
    const schema = t.TABLE_SCHEMA;
    const table = t.TABLE_NAME;
    const isView = t.TABLE_TYPE === 'VIEW';

    if (process.env.DEBUG_DISCOVERY) {
      logger.info('[DISCOVERY] object', { schema, table, type: t.TABLE_TYPE });
    }

    const columns = await getColumns(pool, schema, table);
    // Views are read-only; skip PK lookup
    const pk = isView ? [] : await getPrimaryKey(pool, schema, table);
    const hasTriggers = await hasEnabledTriggers(pool, schema, table);
    const identity = await getIdentityColumn(pool, schema, table);
    const meta = { schema, table, columns, pk, pool, isView, hasTriggers, identity };
    registerRoutes(app, meta, endpoint);

    if (process.env.DEBUG_ROUTES) {
      logger.info(`[ROUTES] base=/${endpoint}/${table} isView=${isView} pk=${pk[0] || 'none'}`);
    }

    // build OpenAPI schema for this object (namespaced by endpoint)
    const name = `${endpointConfig.endpoint}_${table}`;
    const props = {};
    const required = [];
    for (const c of columns) {
      props[c.COLUMN_NAME] = toOpenApiType(c);
      if (c.IS_NULLABLE === 'NO') required.push(c.COLUMN_NAME);
    }
    openApiSchemas[name] = {
      type: 'object',
      properties: props,
      required,
      // capability hints for Swagger generation
      'x-msabon-isView': isView,
      'x-msabon-hasPk': !!(pk && pk.length)
    };

  }

  return openApiSchemas;
}

module.exports = { setupDynamicRoutes };
