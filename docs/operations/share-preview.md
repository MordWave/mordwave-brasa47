# Vista previa al compartir `/menu/<slug>` (9J.3)

Cuando alguien comparte `https://<web>/menu/<slug>`, WhatsApp y otros servicios leen las etiquetas `<meta>` del **HTML inicial** y no ejecutan React. Esta pieza hace que ese HTML ya traiga los datos del restaurante.

## Cómo funciona

```
visita / crawler ── GET /menu/brasa-47 ──▶ Caddy (servicio web)
                                            │ sirve menu-shell.html con la plantilla de <title>
                                            │ httpInclude  /__share-meta?slug=brasa-47&origin=<VITE_PUBLIC_URL>
                                            ▼
                                           reverse_proxy ──▶ API: GET /public/share-meta
                                                              └─ <title>, description, canonical, Open Graph, Twitter
```

- **Build** (`vite.config.js` → `src/seo/menuShell.js`): junto a `index.html` se escribe `dist/menu-shell.html`, idéntico salvo que su `<title>` es una plantilla de Caddy. Todas las demás rutas (`/`, `/admin`, flujo QR de mesas) siguen sirviéndose desde el `index.html` intacto.
- **Caddyfile**: `/menu/*` usa esa plantilla (delimitadores `[#[ … ]#]`, porque `{{ }}` puede aparecer en JS inline). `/__share-meta` reenvía a la API sin cookies ni `Authorization` y con el `Host` de la API. `/menu-shell.html` responde 404 (es solo fuente de plantilla).
- **API** (`backend/src/public-menu/share-meta.*`): devuelve el fragmento `<head>` de un restaurante **activo** (nombre, slug, y logo/portada si existen). Todo valor dinámico se escapa. Slug inexistente, inactivo o mal formado devuelven el mismo cuerpo vacío (200), de modo que la página conserva su título genérico y no se revela nada.
- **URL pública**: nunca sale de un encabezado `Host`. Caddy pasa `VITE_PUBLIC_URL` (variable que el servicio web ya tiene) y la API solo la acepta si coincide con uno de los orígenes de `FRONTEND_URL` (la lista CORS que ya existe). Si no coincide, se omiten `canonical`/`og:url`. La URL se construye con el slug de la base de datos.
- **Sin variables nuevas.** `VITE_API_URL` y `VITE_PUBLIC_URL` ya existen en el servicio web; Caddy las lee del entorno del contenedor.

## Etiquetas

`<title>` (`<Nombre> — Menú`), `description`, `canonical`, `og:type`, `og:site_name`, `og:title` (`<Nombre>`), `og:description` (`Explora la carta digital de <Nombre>`), `og:url`, `og:image` (+ `og:image:alt`) y `twitter:card|title|description|image`.

## Imagen

Se usa **solo** la portada del restaurante (`twitter:card = summary_large_image`) o, si no hay portada, su logo (`summary`). Nunca una foto de producto. Sin logo ni portada no hay etiquetas de imagen y la tarjeta es `summary`. La vista previa sin imagen puede verse distinta o más limitada según la plataforma (algunas muestran solo el título y el dominio, otras un recuadro genérico), y WhatsApp/Instagram guardan en caché lo que leyeron: tras añadir un logo o portada, un enlace ya compartido puede tardar en refrescarse.

## Si algo falla

El fallo nunca rompe la página del menú. Si la API no responde, tarda más de 3 s, devuelve error, o falta `VITE_API_URL`, Caddy sirve el `index.html` normal con estado 200 y el título genérico (solo se pierde la vista previa personalizada). Un caso distinto: si `VITE_API_URL` pasara a tener un valor que Caddy no acepta como dirección de upstream (por ejemplo, con una ruta), el `Caddyfile` no cargaría y Caddy no arrancaría. Hoy ambas variables son orígenes `https://host` simples (sin ruta ni barra final); mantenerlas así.

## Cómo probarlo

- Unitarias y e2e de la API: `backend/src/public-menu/share-*.spec.ts`, `backend/test/share-meta.e2e-spec.ts`.
- Plantilla y build: `src/seo/menuShell.test.js` (siempre).
- Caddyfile real contra una API simulada: `src/seo/menuShell.caddy.test.js`. Necesita un binario de Caddy 2.11.7: en CI se instala fijado y verificado por SHA-512; en local `CADDY_BIN=/ruta/a/caddy npm test` (sin él se omite).
- Tras desplegar: `curl -s https://<web>/menu/<slug> | grep -E '<title>|og:'` debe mostrar los datos del restaurante sin ejecutar JavaScript. La comprobación real en WhatsApp/Instagram solo es posible en producción.
