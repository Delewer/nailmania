import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  Upload,
  X,
} from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';
import { useDialogFocus } from '../dialog-a11y.js';
import {
  PRODUCT_IMPORT_CHUNK_SIZE,
  previewProductImport,
  productImportPayload,
  readProductImportFile,
  suggestImportCategory,
} from '../product-import.js';

const actionLabels = {
  create: 'Nou',
  update: 'Actualizare',
  unchanged: 'Fără schimbări',
  error: 'Verificare necesară',
};

const emptyCounts = () => ({ created: 0, updated: 0, unchanged: 0, failed: 0 });

export default function AdminProductImport({ categories, products, onClose, onComplete, onUnauthorized }) {
  const [parsed, setParsed] = React.useState(null);
  const [sourceFile, setSourceFile] = React.useState('');
  const [mappings, setMappings] = React.useState({});
  const [reading, setReading] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState(null);
  const inputRef = React.useRef(null);
  const requestClose = React.useCallback(() => { if (!importing) onClose(); }, [importing, onClose]);
  const dialogRef = useDialogFocus(requestClose);

  const preview = React.useMemo(
    () => previewProductImport(parsed?.items || [], mappings, products),
    [mappings, parsed?.items, products],
  );
  const importable = preview.entries.filter((entry) => ['create', 'update'].includes(entry.action));
  const blocked = Boolean(parsed?.errors.length || preview.counts.error);
  const updateItem = React.useCallback((sheetRow, changes) => {
    setParsed((current) => current ? {
      ...current,
      items: current.items.map((item) => item.sheetRow === sheetRow ? { ...item, ...changes } : item),
    } : current);
  }, []);

  const selectFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setReading(true);
    setError('');
    setResult(null);
    try {
      const next = await readProductImportFile(file);
      setParsed(next);
      setSourceFile(file.name);
      setMappings(Object.fromEntries(next.groups.map((group) => [group, suggestImportCategory(group, categories)])));
    } catch (readError) {
      setParsed(null);
      setSourceFile('');
      setMappings({});
      setError(readError.message || 'Fișierul Excel nu a putut fi citit');
    } finally {
      setReading(false);
    }
  };

  const runImport = async () => {
    if (!parsed || blocked || !importable.length || importing) return;
    setImporting(true);
    setError('');
    setResult(null);
    setProgress({ done: 0, total: importable.length });
    const totals = { ...emptyCounts(), unchanged: preview.counts.unchanged };
    const importId = crypto.randomUUID();
    let completedRequests = 0;
    try {
      for (let index = 0; index < importable.length; index += PRODUCT_IMPORT_CHUNK_SIZE) {
        const chunk = importable.slice(index, index + PRODUCT_IMPORT_CHUNK_SIZE);
        const response = await adminRequest('/api/admin/products/import', {
          method: 'POST',
          body: {
            importId,
            sourceFile,
            items: chunk.map(productImportPayload),
          },
        });
        for (const key of Object.keys(totals)) totals[key] += Number(response.counts?.[key] || 0);
        completedRequests += 1;
        setProgress({ done: Math.min(index + chunk.length, importable.length), total: importable.length });
        if (Number(response.counts?.failed || 0) > 0) {
          throw new Error(`${response.counts.failed} produse au fost modificate simultan și trebuie verificate`);
        }
      }
      setResult(totals);
      await onComplete();
    } catch (requestError) {
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized();
      if (completedRequests) {
        setResult(totals);
        await onComplete();
        setError(`Import parțial: ${requestError.message}. Produsele din etapele finalizate au fost păstrate.`);
      } else {
        setError(requestError.message || 'Importul nu a putut fi finalizat');
      }
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="adm-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <aside className="adm-drawer adm-import-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Import produse din Excel" tabIndex={-1}>
        <header className="adm-drawer-head">
          <div><span>Catalog</span><h2>Import produse din Excel</h2></div>
          <button className="adm-icon-btn" type="button" onClick={requestClose} disabled={importing} title="Închide" aria-label="Închide" data-dialog-initial-focus><X size={20}/></button>
        </header>

        <div className="adm-import-body">
          <section className="adm-import-intro">
            <FileSpreadsheet size={24}/>
            <div>
              <b>Date pentru fișa produsului</b>
              <p>Codul, denumirea și grupa sunt detectate obligatoriu. Brandul, prețul, stocul magazinului, descrierea, linkul imaginii și starea sunt preluate când există.</p>
              <p>După selectarea fișierului puteți corecta fiecare câmp înainte de salvare. Câmpurile care lipsesc sunt păstrate la produsele existente.</p>
            </div>
          </section>

          <input ref={inputRef} type="file" accept=".xls,.xlsx" onChange={selectFile} hidden aria-label="Fișier Excel pentru import"/>
          <button className="adm-import-file" type="button" onClick={() => inputRef.current?.click()} disabled={reading || importing}>
            {reading ? <LoaderCircle className="adm-spin" size={22}/> : <Upload size={22}/>}
            <span><b>{reading ? 'Se citește fișierul' : sourceFile || 'Selectează fișierul .xls sau .xlsx'}</b><small>Maximum 5 MB și 500 de produse</small></span>
          </button>

          {error && <div className="adm-import-message error" role="alert"><AlertTriangle size={18}/><span>{error}</span></div>}
          {result && !error && (
            <div className="adm-import-message success" role="status"><CheckCircle2 size={18}/><span>Import finalizat: {result.created} noi, {result.updated} actualizate, {result.unchanged} fără schimbări, {result.failed} neimportate.</span></div>
          )}

          {parsed && (
            <>
              <section className="adm-import-summary" aria-label="Rezumat fișier">
                <div><span>Foaie</span><b>{parsed.sheetName}</b></div>
                <div><span>Rânduri</span><b>{parsed.rowCount}</b></div>
                <div><span>Noi</span><b>{preview.counts.create}</b></div>
                <div><span>Actualizări</span><b>{preview.counts.update}</b></div>
                <div><span>Neschimbate</span><b>{preview.counts.unchanged}</b></div>
                <div><span>De verificat</span><b>{preview.counts.error}</b></div>
              </section>

              <section className="adm-import-mapping">
                <div className="adm-section-head"><h3>Maparea grupelor la categorii</h3></div>
                {parsed.groups.map((group) => (
                  <label key={group}>
                    <span>{group}</span>
                    <select value={mappings[group] || ''} onChange={(event) => setMappings((current) => ({ ...current, [group]: event.target.value }))} disabled={importing}>
                      <option value="">Selectează categoria</option>
                      {categories.map((category) => <option key={category.id} value={category.id}>{category.name_ro}</option>)}
                    </select>
                  </label>
                ))}
              </section>

              {parsed.errors.length > 0 && (
                <section className="adm-import-errors" role="alert">
                  <h3><AlertTriangle size={17}/>Corectați {parsed.errors.length} erori în fișier</h3>
                  <ul>{parsed.errors.slice(0, 12).map((item, index) => <li key={`${item.row}-${item.field}-${index}`}>Rândul {item.row}{item.sku ? ` · ${item.sku}` : ''}: {item.message}</li>)}</ul>
                  {parsed.errors.length > 12 && <p>Și încă {parsed.errors.length - 12} erori.</p>}
                </section>
              )}

              <section className="adm-import-preview">
                <div className="adm-section-head"><h3>Previzualizare editabilă</h3><span>Identificare după SKU · toate câmpurile pot fi modificate</span></div>
                <div className="adm-import-table-wrap">
                  <table>
                    <thead><tr><th>Rând</th><th>SKU</th><th>Produs</th><th>Brand</th><th>Categorie</th><th>Preț</th><th>Stoc</th><th>Descriere</th><th>Link imagine</th><th>Activ</th><th>Acțiune</th></tr></thead>
                    <tbody>{preview.entries.map((entry) => (
                      <tr key={`${entry.sheetRow}-${entry.sku}`}>
                        <td>{entry.sheetRow}</td>
                        <td><input value={entry.sku} maxLength={80} onChange={(event) => updateItem(entry.sheetRow, { sku: event.target.value })} disabled={importing}/><small>{entry.sourceGroup}</small></td>
                        <td><input value={entry.nameRo} maxLength={300} onChange={(event) => updateItem(entry.sheetRow, { nameRo: event.target.value })} disabled={importing}/></td>
                        <td><input value={entry.brand} maxLength={180} onChange={(event) => updateItem(entry.sheetRow, { brand: event.target.value, brandProvided: true })} disabled={importing}/></td>
                        <td><select value={entry.categoryId} onChange={(event) => updateItem(entry.sheetRow, { categoryId: event.target.value })} disabled={importing}><option value="">Selectează</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name_ro}</option>)}</select></td>
                        <td><input type="number" min="0" step="1" value={entry.price ?? ''} onChange={(event) => updateItem(entry.sheetRow, { price: event.target.value === '' ? null : Number(event.target.value), priceProvided: true })} disabled={importing}/></td>
                        <td><input type="number" min="0" step="1" value={entry.stock ?? ''} onChange={(event) => updateItem(entry.sheetRow, { stock: event.target.value === '' ? null : Number(event.target.value), stockProvided: true })} disabled={importing}/></td>
                        <td><textarea value={entry.descriptionRo || ''} maxLength={20000} onChange={(event) => updateItem(entry.sheetRow, { descriptionRo: event.target.value, descriptionProvided: true })} disabled={importing}/></td>
                        <td><input type="url" value={entry.imageUrl || ''} maxLength={2048} placeholder="https://…" onChange={(event) => updateItem(entry.sheetRow, { imageUrl: event.target.value, imageProvided: true })} disabled={importing}/></td>
                        <td><input type="checkbox" checked={entry.isActive} onChange={(event) => updateItem(entry.sheetRow, { isActive: event.target.checked, stateProvided: true })} disabled={importing}/></td>
                        <td><span className={`adm-import-action ${entry.action}`}>{actionLabels[entry.action]}</span>{entry.validationErrors?.length > 0 && <small title={entry.validationErrors.join(', ')}>{entry.validationErrors.join(', ')}</small>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="adm-import-footer">
          {importing && <span role="status">Importate {progress.done} din {progress.total}</span>}
          {!importing && result && !error && <span>Lista produselor a fost actualizată.</span>}
          <button className="adm-compact-btn" type="button" onClick={requestClose} disabled={importing}>Închide</button>
          <button className="adm-primary" type="button" onClick={runImport} disabled={!parsed || blocked || !importable.length || importing || reading}>
            {importing ? <LoaderCircle className="adm-spin" size={17}/> : <Upload size={17}/>}
            {importing ? 'Se importă' : `Importă ${importable.length || ''}`}
          </button>
        </footer>
      </aside>
    </div>
  );
}
