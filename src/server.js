const express = require('express');
const cors = require('cors');
const fs = require('fs');
const yaml = require('js-yaml');
const sql = require('mssql');
const { setupDynamicRoutes } = require('./generator');
const swaggerUi = require('swagger-ui-express');
const logger = require('./logger');
let openApi = null;

process.on('unhandledRejection', (e) => logger.error('UnhandledRejection:', e.stack || e));
process.on('uncaughtException', (e) => logger.error('UncaughtException:', e.stack || e));

async function connectAndSetupWithRetry(app, components, c, attempt = 0) {
  const endpoint = c.endpoint || 'api';
  const poolConfig = {
    user: c.username,
    password: c.password,
    server: c.server,
    port: c.port || 1433,
    database: c.database,
    options: { encrypt: false, enableArithAbort: true }
  };
  const doAttempt = async () => {
    try {
      const pool = await new sql.ConnectionPool(poolConfig).connect();
      logger.info(`Connected to ${endpoint}`);
      const schemas = await setupDynamicRoutes(app, pool, c);
      components.schemas = { ...components.schemas, ...schemas };
      if (process.env.DEBUG_SWAGGER) {
        console.log(`[RETRY] endpoint='${endpoint}' routes registered on attempt ${attempt + 1}`);
      }
    } catch (err) {
      logger.error(`Connection failed for endpoint '${endpoint}':`, err.stack || err.message);
      const delayMs = 30000;
      logger.warn(`[RETRY] endpoint='${endpoint}' in ${Math.round(delayMs/1000)}s (attempt ${attempt + 1})`);
      setTimeout(() => connectAndSetupWithRetry(app, components, c, attempt + 1), delayMs);
    }
  };
  await doAttempt();
}

async function start() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // health
  app.get('/health', (req, res) => res.json({ ok: true }));

  // request logging middleware
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`);
    if (req.method !== 'GET' && req.body && Object.keys(req.body).length) {
      logger.verbose('  body=', req.body);
    }
    next();
  });

  // load config
  const cfgPath = process.env.CONFIG_PATH || 'config.yaml';
  let cfg;
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    cfg = yaml.load(raw);
    logger.info('Loaded config', cfgPath);
  } catch (err) {
    logger.error('Failed to load config.yaml:', err.message);
    process.exit(1);
  }

  const port = process.env.PORT || cfg.port || 3000;

  // collect all schemas across endpoints
  const components = { schemas: {} };

  // Build a mutable OpenAPI object once, then refresh paths when routes register
  let openApi = {
    openapi: '3.0.0',
    info: { title: "MS SQL API built on NodeJS (MsABON)", version: '0.2.0' },
    servers: [{ url: `http://localhost:${port}` }],
    components,
    paths: {},
    tags: [
      { name: 'Views', description: 'Read-only SQL views' },
      { name: 'Tables', description: 'Tables (CRUD where applicable)' }
    ]
  };

  // Helper: rebuild paths from components.schemas
  function buildPathsFromComponents() {
    openApi.paths = {};
    for (const name of Object.keys(openApi.components.schemas)) {
      const sch = openApi.components.schemas[name] || {};
      const isView = sch['x-msabon-isView'] === true;
      const hasPk = sch['x-msabon-hasPk'] === true;

      const parts = name.split('_');
      const endpoint = parts[0];
      const table = parts.slice(1).join('_');
      const base = `/${endpoint}/${table}`;

      const tag = isView ? 'Views' : 'Tables';

      // Always list
      openApi.paths[base] = {
        get: {
          tags: [tag],
          summary: `List ${table}`,
          parameters: [
            {
              in: 'query',
              name: 'order',
              description: 'Sort as "column.asc" or "column.desc".',
              schema: { type: 'string', example: 'id.asc' }
            },
            {
              in: 'query',
              name: 'limit',
              description: 'Rows to return (-1 returns all). Default -1.',
              schema: { type: 'integer', default: -1 }
            },
            {
              in: 'query',
              name: 'offset',
              description: 'Rows to skip before starting the result set. Default 0.',
              schema: { type: 'integer', default: 0 }
            }
          ],
          responses: { '200': { description: 'OK' } }
        }
      };

      // Create only for tables with PK
      if (!isView && hasPk) {
        openApi.paths[base].post = {
          tags: [tag],
          summary: `Create ${table}`,
          requestBody: {
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
          },
          responses: { '201': { description: 'Created' } }
        };
      }

      // ID routes only when PK exists
      if (hasPk) {
        const idPath = `${base}/{id}`;
        openApi.paths[idPath] = {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: {
            tags: [tag],
            summary: `Get ${table} by id`,
            responses: { '200': { description: 'OK' }, '404': { description: 'Not Found' } }
          }
        };

        // Update/Delete ONLY for tables (not views)
        if (!isView) {
          openApi.paths[idPath].put = {
            tags: [tag],
            summary: `Update ${table}`,
            requestBody: {
              content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
            },
            responses: { '200': { description: 'Updated' } }
          };
          openApi.paths[idPath].delete = {
            tags: [tag],
            summary: `Delete ${table}`,
            responses: { '200': { description: 'Deleted' }, '404': { description: 'Not Found' } }
          };
        }
      }

      if (process.env.DEBUG_SWAGGER) {
        console.log(`[SWAGGER] ${name} tag=${tag} isView=${isView} hasPk=${hasPk} base=${base}`);
      }
    }
  }

  // setup each connection (non-blocking; routes will register on success or retry)
  for (const c of cfg.connections || []) {
    const endpoint = c.endpoint || 'api';
    logger.info(`Connecting to ${c.server}:${(c.port || 1433)}/${c.database} as ${c.username} (endpoint='${endpoint}')`);
    // Wrap the original retry function to rebuild spec after merge
    connectAndSetupWithRetry(app, components, c).then(() => {
      // The retry function merges schemas on success; rebuild paths now
      buildPathsFromComponents();
    }).catch(() => {
      // Error already logged in connectAndSetupWithRetry; do nothing here
    });
  }

  // serve swagger: load spec from URL so UI reflects updates in /swagger.json
  app.use(cfg.swaggerPath || '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      swaggerOptions: {
        urls: [{ url: '/swagger.json', name: 'MsABON' }],
        tagsSorter: 'alpha',
        operationsSorter: 'alpha'
      }
    })
  );

  // JSON endpoint serving the current spec
  app.get('/swagger.json', (req, res) => res.json(openApi));

  // initial build (empty until a connection succeeds)
  buildPathsFromComponents();

  app.listen(port, () => {
    logger.info(`Server listening on http://localhost:${port}`);
    logger.info(`If you would like to use the swagger to test your endpoints, go to http://localhost:${port}${cfg.swaggerPath || '/api-docs'}`);
  });
}

start().catch(err => {
  logger.error(err);
  process.exit(1);
});
