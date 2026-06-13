# raglike-cli 🛠️

The `raglike-cli` is a high-performance terminal tool designed to synchronize your local Markdown and PDF documents with the `raglike-md` knowledge engine. It provides a simple, efficient way to keep your local knowledge bases up to date without manual uploads.

## 🚀 Installation

Since `raglike-cli` is built with Bun, you can install it globally or run it directly using `bun x`.

### Zero-Install (Run with bun x)
If you are in the project root, you can run the CLI without installing it:
```bash
bun x ./cli <directory>
```

### Global Installation
```bash
bun run install-cli
# Now you can use raglike-cli from anywhere
```

### Manual Installation (if not using the root script)
```bash
bun install -g ./cli
```

---

## ⚙️ Configuration

To avoid passing the server URL and API token on every command, you can use a `.raglike` configuration file.

### `.raglike` Config File
Create a `.raglike` (JSON) file in your current working directory or your home directory (`~/.raglike`).

```json
{
  "server": "http://localhost:4321",
  "token": "your_secure_token"
}
```

**Note:** If no configuration file is found, you **must** provide the `--server` or `--token` flags explicitly.

---

## 📖 Usage

### Basic Sync
Synchronize all `.md` and `.pdf` files in the current directory:
```bash
raglike-cli .
```

### Custom Server & Token
Override config file settings or run without a config file:
```bash
raglike-cli ./my-docs --server http://rag.example.com --token my_secret_token
```

### Options
| Flag | Short | Description |
| :--- | :--- | :--- |
| `--server` | `-s` | The URL of your `raglike-md` server. |
| `--token` | `-t` | Your API Bearer token. |
| `--help` | `-h` | Show the help message. |

---

## 🔄 How it Works

1. **Discovery:** Recursively scans the target directory for supported file types (`.md`, `.pdf`).
2. **Delta Sync:** Fetches the current state from the server via `GET /list-docs`.
3. **Comparison:** Only uploads files that are either missing from the server or have a different file size.
4. **Fast Upload:** Uses `multipart/form-data` to send the documents to the engine for immediate indexing.

## 📦 Publishing to npm (For Maintainers)

If you want to make `raglike-cli` available globally via `bun x`, follow these steps to publish the `cli/` subdirectory as a standalone package.

1. **Change into the CLI directory:**
   ```bash
   cd cli
   ```

2. **Login to npm (if not already):**
   ```bash
   bunx npm login
   ```

3. **Check the package name:**
   Ensure the `"name"` in `cli/package.json` is unique. If `raglike-cli` is already taken, you might want to use a scoped name like `@your-username/raglike-cli`.

4. **Publish:**
   ```bash
   bun publish
   ```

Once published, users can run it instantly:
```bash
bun x raglike-cli ./my-docs
```
