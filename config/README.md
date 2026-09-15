# Config directory

Place your Infor ION API credentials file here as `credentials.ionapi`.

**This file is never committed to git** (see `.gitignore`) and is only ever
read by the Node.js server process — it is never sent to the browser.

## How to get this file

Export a service account `.ionapi` file from the Infor OS Portal for your
tenant (API Gateway > Authorized Apps), and save it as:

```
config/credentials.ionapi
```

Alternatively, set the `IONAPI_PATH` environment variable to point to the
file wherever it lives on disk, e.g.:

```
set IONAPI_PATH=C:\Users\yourname\Downloads\KIRO (2).ionapi
npm start
```
