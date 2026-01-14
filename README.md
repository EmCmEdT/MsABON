# MS SQL API built on NodeJS (MsABON)

MsABON automatically discovers MS SQL tables and views matching configured filters and exposes REST endpoints for them. It also generates OpenAPI (Swagger) documentation for quick testing.

## Setup

MsABON is built on NodeJS, which can be installed in a variety of ways: installed from exe installer (admin required), unzipped and paths mapped or locally executed (no admin), or with a tool like scoop or chocolatey (no admin, usually). This was originally built and tested on both mapped and locally executed installations of v22.21.1 LTS NodeJS. Here is the download link:

https://nodejs.org/en/download

Once NodeJS is installed, proceed with the setup.

1. Install dependencies:

```bash
npm install
```

2. Edit `config.yaml` (project root) to describe one or more connections and app settings. Example:

```yaml
port: 3000
swaggerPath: /swagger
logLevel: verbose

connections:
  - endpoint: __ENPT1__
    server: __SRVR1__
    port: 1433
    username: __USER1__
    password: __PASS1__
    database: __DTBS1__
    filter: __REGX1__
  - endpoint: __ENPT2__
    server: __SRVR2__
    port: 1433
    username: __USER2__
    password: __PASS2__
    database: __DTBS2__
    filter: __REGX2__
```

Notes about the config fields
- `port`: default server port (can be overridden with `PORT` env var).
- `swaggerPath`: where Swagger UI is served (default `/api-docs` if not set).
- `logLevel`: currently respected informally; logger prints `info` & `verbose` messages.
- `connections`: list of connection entries. Each entry:
  - `endpoint`: logical name used in the HTTP path and OpenAPI component names.
  - `server`, `port`, `username`, `password`, `database`: DB connection info.
  - `filter`: a simple regex-like filter (e.g. `^MI`) translated to SQL `LIKE` (becomes `MI%`) to select table/view names.

3. Start server:

```powershell
npm start
```

## Behavior & routing

- The server tries to connect to each entry in `connections`. For each successful connection it:
  - discovers tables and views matching `filter` (SQL LIKE semantics),
  - introspects columns and primary keys, and
  - registers routes under `/{endpoint}/{table}`.

- Views are read-only (GET only).
- Tables support CRUD when a primary key is present:
  - `GET /{endpoint}/{table}` list (with filters and sorting/pagination)
  - `GET /{endpoint}/{table}/{id}` get by PK
  - `POST /{endpoint}/{table}` create
  - `PUT /{endpoint}/{table}/{id}` update by PK
  - `DELETE /{endpoint}/{table}/{id}` delete by PK

Examples
- List rows: `GET /mis/MILabels`
- Get by id: `GET /mis/MILabels/{id}`

### Health and discovery endpoints

- `GET /` → JSON `{"ok": true}` health check.
- `GET /{endpoint}/` → lists discovered objects for the endpoint, grouped by tables vs views.

Example discovery payload:

```json
{"endpoint":"api","tables":["Users","Products","Posts"],"views":["PostsView","UserList","ActiveProducts"]}
```

## List endpoint query parameters

The list endpoints (`GET /{endpoint}/{table}`) support Supabase/PostgREST-style query parameters:

- `order`: Sort order in the format `column.asc` or `column.desc`. Default is ascending (ASC).
  - Example: `?order=id.desc`
- `limit`: Number of rows to return. `-1` returns all (default).
  - Example: `?limit=50`
- `offset`: Number of rows to skip before starting the result set. Default `0`.
  - Example: `?offset=100`

You can also filter by any column via query string:
- `GET /mis/MILabels?Name=Widget&Status=Active`

Putting it together:
- `GET /mis/MILabels?order=id.desc&limit=25&offset=50`
- `GET /mis/MILabels?CreatedAt.asc` (default ASC if direction omitted)

## Swagger & OpenAPI

- Swagger UI is available at `http://localhost:<port>/<swaggerPath>` (default `/api-docs` if not set).
- OpenAPI JSON served at `http://localhost:<port>/swagger.json`.
- The UI loads the spec from `/swagger.json`, and groups endpoints under two tags:
  - `Views` (read-only)
  - `Tables` (CRUD where applicable)

The server prints a clickable link to Swagger UI on startup.

## Logging & safety

- The console logger is verbose by default; you will see timestamped `INFO`, `WARN`, `ERROR`, and `VERBOSE` messages about discovery and executed SQL (parameters are shown; passwords are not printed).
- Passwords are not printed; sensitive values are masked in high-level logs.

## Magic numbers / hard-coded defaults

- Default port: `3000` (in `config.yaml` or `PORT` env var).
- Default SQL port: `1433` when `port` is not provided in a connection entry.
- List defaults: `order` -> ASC on PK or first column, `limit` -> `-1`, `offset` -> `0`.

## Advanced

- To change the config file name/location, before starting (`npm start`), set `CONFIG_PATH` env var  (`$env:CONFIG_PATH = 'config.yaml'`).
- To run multiple APIs from different servers/databases, add multiple entries to `connections`; each `endpoint` yields its own namespaced routes and OpenAPI components.
- If a connection fails (e.g., DNS down), the server retries every 30 seconds without stopping. When the connection succeeds, routes and the Swagger spec are updated automatically.
