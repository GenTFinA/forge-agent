---
description: "Diagnóstico do projeto Forge — valida regras de ignore (Camada 1), versão de schema (Camada 2) e projeções versionadas por engano (Camada 3). Use --fix para aplicar correções."
allowed-tools: Read, Write, Edit, Bash
---

Você está executando o diagnóstico do projeto Forge. Siga os passos abaixo na ordem.

## Input

$ARGUMENTS

---

## Step 1: Parse flags

Verifique se `--fix` está presente em `$ARGUMENTS`:

```bash
# Exemplo de detecção (lógica interna — não exibir ao usuário)
# Se "$ARGUMENTS" contiver "--fix", o modo fix está ativo.
```

Guarde internamente: `FIX_MODE=true` se `--fix` for encontrado, caso contrário `FIX_MODE=false`.

---

## Step 2: Layer 1 — Ignore rules

Execute a validação das regras de ignore:

```bash
node scripts/forge-ignore.js --validate
```

Capture a saída completa e o exit code.

- Se exit code `0`: Layer 1 passou — `LAYER1_STATUS=ok`.
- Se exit code `1`: Layer 1 falhou — `LAYER1_STATUS=fail`. Guarde a lista de paths faltantes da saída.
- Se VCS for `none` (detectado na saída como `vcs: none`): Layer 1 é pulada — `LAYER1_STATUS=skipped`. Imprima:
  ```
  VCS: none — Layer 1 check skipped
  ```

---

## Step 3: Apply fix Layer 1 (if --fix)

Execute este passo **somente se** `FIX_MODE=true` **e** `LAYER1_STATUS=fail`.

1. Aplique as correções:

```bash
node scripts/forge-ignore.js --apply
```

2. Re-valide para confirmar:

```bash
node scripts/forge-ignore.js --validate
```

3. Se a re-validação passar (exit code `0`): `LAYER1_STATUS=fixed`.
4. Se ainda falhar: `LAYER1_STATUS=fail` (liste os paths ainda faltantes).

---

## Step 4: Layer 2 — Schema version

Execute a verificação de versão de schema:

```bash
node scripts/forge-doctor.js --check schema
```

Capture a saída completa e o exit code.

- Se exit code `0`: Layer 2 passou — `LAYER2_STATUS=ok`.
- Se exit code `1`: Layer 2 falhou — `LAYER2_STATUS=fail`. Guarde a mensagem de mismatch da saída.

**Saída de exemplo (ok):**
```
Forge Doctor
============

  ✓ Layer 2 — Schema version
    Schema version matches: fragment-store@1.0.0

  Summary: 1/1 checks passed
```

**Saída de exemplo (mismatch):**
```
Forge Doctor
============

  ✗ Layer 2 — Schema version
    Schema version mismatch — expected "fragment-store@1.0.0", got "fragment-store@0.9.0". Run --fix to update.

  Summary: 0/1 checks passed
```

---

## Step 5: Apply fix Layer 2 (if --fix)

Execute este passo **somente se** `FIX_MODE=true` **e** `LAYER2_STATUS=fail`.

```bash
node scripts/forge-doctor.js --fix
```

Re-execute o check de schema e atualize `LAYER2_STATUS` conforme o resultado.

---

## Step 6: Layer 3 — Projection versioned by mistake

Execute a verificação de projeções rastreadas por VCS:

```bash
node scripts/forge-doctor.js --check projection-versioned
```

Capture a saída completa e o exit code.

- Se exit code `0`: Layer 3 passou — `LAYER3_STATUS=ok`.
- Se exit code `1`: Layer 3 falhou — `LAYER3_STATUS=fail`. Guarde a lista de arquivos rastreados da saída.
- Se a saída contiver `skipped: not-git`: Layer 3 é pulada — `LAYER3_STATUS=skipped`.

**Saída de exemplo (ok):**
```
Forge Doctor
============

  ✓ Layer 3 — Projection versioned
    No projection monoliths are tracked by git.

  Summary: 1/1 checks passed
```

**Saída de exemplo (fail):**
```
Forge Doctor
============

  ✗ Layer 3 — Projection versioned
    2 projection monolith(s) accidentally tracked by git (should be in .gitignore): .gsd/LEDGER.md, .gsd/DECISIONS.md
      - .gsd/LEDGER.md
      - .gsd/DECISIONS.md

  Summary: 0/1 checks passed
```

---

## Step 7: Apply fix Layer 3 (if --fix)

Execute este passo **somente se** `FIX_MODE=true` **e** `LAYER3_STATUS=fail`.

```bash
node scripts/forge-doctor.js --fix
```

O comando exibirá os arquivos rastreados por engano e sugerirá o comando `node scripts/forge-ignore.js --apply` para adicionar as entradas de ignore. Execute-o se ainda não o fez:

```bash
node scripts/forge-ignore.js --apply
```

Aviso ao usuário: `git rm --cached <path>` é necessário para remover os arquivos do índice git (não feito automaticamente para evitar perda de dados).

---

## Step 8: Report

Exiba o relatório final consolidado:

```
Forge Doctor
============

  Layer 1 — Ignore rules
    VCS detected: <git|svn|none>
    Status: ✓ OK
    (ou)
    Status: ✗ <N> paths missing:
      - <path1>
      - <path2>
    (ou)
    Status: — skipped (VCS: none)

  Layer 2 — Schema version
    Status: ✓ OK  (fragment-store@1.0.0)
    (ou)
    Status: ✗ mismatch — expected "fragment-store@1.0.0", got "<actual>"
    (ou)
    Status: ✗ SCHEMA-VERSION not found

  Layer 3 — Projection versioned
    Status: ✓ OK  (no projections tracked)
    (ou)
    Status: ✗ <N> projections accidentally tracked:
      - <path1>
    (ou)
    Status: — skipped (VCS: none)

  Summary: <X>/<Y> checks passed
  <se --fix e alguma correção foi aplicada:>
  Fixes applied: <N> actions taken.
```

Regras de formatação do relatório:

- `✓` — check passou (ou foi corrigido com --fix)
- `✗` — check falhou
- `—` — check pulado (VCS none)
- **Summary:** conta somente checks efetivamente executados (VCS none = 0 checks para Layer 1 e Layer 3); formato `X/Y checks passed`

---

<!-- Layer 1: forge-ignore.js --validate (S01) -->
<!-- Layer 2: forge-doctor.js --check schema (S05/T04) -->
<!-- Layer 3: forge-doctor.js --check projection-versioned (S05/T04) -->
