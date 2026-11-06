import { useEffect, useState } from 'react';
import { loadCatalog, type Catalog } from '../lib/catalog';

export type CatalogStatus = 'loading' | 'ready' | 'failed';

/** Starts the lazy fetch when a screen that needs it mounts. Failure leaves plain text inputs. */
export function useCatalog(): { catalog: Catalog | null; status: CatalogStatus } {
  const [state, setState] = useState<{ catalog: Catalog | null; status: CatalogStatus }>({ catalog: null, status: 'loading' });
  useEffect(() => {
    let live = true;
    loadCatalog().then(
      (catalog) => live && setState({ catalog, status: 'ready' }),
      () => live && setState({ catalog: null, status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
