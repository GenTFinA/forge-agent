---
description: "Diagnóstico do projeto Forge — valida regras de ignore (Camada 1). Use --fix para aplicar correções."
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

## Step 3: Apply fix (if --fix)

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

## Step 4: Report

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

  Summary: <X>/<Y> checks passed
  <se --fix e alguma correção foi aplicada:>
  <N> paths adicionados.
```

Regras de formatação do relatório:

- `✓ Layer 1 ignore rules: OK` — quando `LAYER1_STATUS=ok` ou `LAYER1_STATUS=fixed`
- `✗ Layer 1 ignore rules: <N> missing` — quando `LAYER1_STATUS=fail`, com lista dos paths faltantes
- `— Layer 1 ignore rules: skipped` — quando `LAYER1_STATUS=skipped`
- **Summary:** conta somente checks efetivamente executados (VCS none = 0 checks); formato `X/Y checks passed`

---

<!-- Future checks: Layer 2 (projection ignore — S02-S05), schema version marker (S05) -->
