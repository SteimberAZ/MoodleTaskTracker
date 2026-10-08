# mineral tareas

Web app para estudiantes de la **UTM** que reúne las tareas de Moodle (`evirtual.utm.edu.ec`), avisa antes de cada fecha límite y permite crear recordatorios propios y avisos del horario de clases. El acceso es **solo por invitación**: cada persona entra con su usuario de la UTM y un código de un solo uso.

---

## Arquitectura

| Pieza | Dónde corre | Qué hace |
| --- | --- | --- |
| `web/` (Next.js 15) | Vercel | Login con la cuenta de Moodle, tareas, recordatorios, horario, historial de avisos, administración. Solo guarda datos; nunca envía notificaciones. |
| Base de datos | Supabase self-hosted, **compartido con Mineral** | Solo las tablas `moodle_*` son de este proyecto. El acceso pasa por el rol `moodle_app`, que no puede tocar nada fuera de `moodle_*`. |
| `worker.py` (Python) | VPS, bajo pm2 | Cada minuto envía los recordatorios y avisos pendientes. Cada 30 minutos, y justo después de cada inicio de sesión, sincroniza las tareas de cada usuario con su token de la API de Moodle. Guarda su estado local en `moodle_tasks.db` (SQLite). |

**Canales de aviso:**

- **Web Push** es el canal principal: notificaciones nativas en cada dispositivo donde el usuario las activó en **Notificaciones**.
- **ntfy** es opcional y se maneja en **Mi cuenta** (`/cuenta`). Un aviso por ntfy solo cuenta como entregado cuando el usuario confirmó que lo recibe.

Cada aviso queda en el historial (**Avisos**). Al tocar la notificación se abre esa entrada, con un botón hacia la tarea o página relacionada.

---

## Desarrollo local

Requisitos: Python 3.12 y Node 22 (ver `web/.nvmrc`).

**Worker:**

```
python -m venv venv
venv/bin/pip install -r requirements-dev.txt     # en Windows: venv\Scripts\pip
python -m pytest -q
```

Los tests de Web Push se saltan si faltan `pywebpush`, `http_ece`, `py_vapid` o `cryptography`. En CI (`CI=true`) eso hace fallar la corrida.

**Web:**

```
cd web
cp .env.example .env.local   # completa los valores
npm ci
npm run dev
npm test && npx tsc --noEmit
```

**CI:** `.github/workflows/ci.yml` corre en cada pull request y en cada push a `main`. Ejecuta los tests de Python en Linux y, para la web, typecheck, tests y `next build` con variables de prueba.

---

## Variables de entorno

### Vercel (web)

| Variable | | Uso |
| --- | --- | --- |
| `SUPABASE_URL` | obligatoria | URL de la API de Supabase. |
| `SUPABASE_ANON_KEY` | obligatoria | Anon key de la instancia (va como header `apikey`). |
| `MOODLE_DB_JWT` | obligatoria | JWT del rol `moodle_app` (ver [Base de datos](#1-base-de-datos)). |
| `ADMIN_MOODLE_USERNAME` | obligatoria | Tu usuario de la UTM: entra sin código y queda como administrador. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | obligatoria para Web Push | Clave **pública** VAPID. Se incrusta al compilar, así que hay que redesplegar después de cambiarla. |
| `SESSION_SECRET` | opcional | Firma la cookie de sesión. Si falta, se deriva de `MOODLE_DB_JWT`. Definirla permite cerrar todas las sesiones sin cambiar el JWT. |
| `ADMIN_NTFY_TOPIC` | opcional | Tu tema de ntfy, que se conserva al crear la cuenta admin. Si falta, se genera uno aleatorio. |
| `MOODLE_URL` | opcional | Por defecto `https://evirtual.utm.edu.ec`. |
| `NTFY_SERVER` | opcional | Servidor de ntfy para la prueba y el enlace de suscripción. Por defecto `https://ntfy.sh`. |

Fuera de `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, ninguna variable lleva el prefijo `NEXT_PUBLIC_`. `APP_PASSWORD` y `SUPABASE_SERVICE_ROLE_KEY` ya no se usan.

### VPS (worker, archivo `.env` junto a `worker.py`)

La plantilla completa, con un comentario por variable, está en `.env.example`.

| Variable | | Uso |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MOODLE_DB_JWT` | obligatorias | Los mismos valores que en Vercel. |
| `VAPID_SUBJECT` | obligatoria | Contacto para los servicios push, por ejemplo `mailto:tu@correo`. |
| `VAPID_PRIVATE_KEY_FILE` | opcional | Ruta del PEM privado. Por defecto `./vapid_private.pem`. |
| `VAPID_PUBLIC_KEY_EXPECTED` | recomendada | Igual a `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. Si no coincide con el PEM, el worker desactiva Web Push y lo informa. |
| `MOODLE_URL` | opcional | Por defecto `https://evirtual.utm.edu.ec`. |
| `NTFY_SERVER` | opcional | Por defecto `https://ntfy.sh`. |
| `NTFY_TOPIC` | opcional | Sin valor por defecto. Se usa solo para el horario de clases integrado cuando no existe ningún usuario admin. |
| `WEB_APP_URL` | opcional | URL pública de la web, sin barra final. Permite que tocar un aviso de ntfy abra la página correspondiente. |
| `HEALTHCHECK_URL` | opcional | Dead-man switch: el worker la consulta al final de cada ciclo y agrega `/fail` cuando algo falló (por ejemplo, un check de healthchecks.io). |
| `WORKER_STRICT` | opcional | Con `1`, el worker se detiene al arrancar si falta la base de datos o Web Push. Sin ella, sigue funcionando en modo degradado y lo muestra en `/admin`. |

Variables antiguas que hay que **quitar** del `.env`: `MOODLE_SESSION`, `MOODLE_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_KEY`. Los tokens de Moodle se leen de la base, y la key de servicio no debe usarse en una instancia compartida.

---

## Primera instalación

### 1. Base de datos

1. Ejecuta `supabase_schema.sql` completo como administrador, en el SQL Editor de Studio o con `psql`. Es idempotente (se puede volver a ejecutar) y no modifica objetos fuera de `moodle_*`.
2. Genera el JWT del rol con el `JWT_SECRET` de la instancia:
   ```
   JWT_SECRET=<jwt secret de la instancia> python scripts/make_moodle_jwt.py --years 5
   ```

### 2. VPS

```
git clone <repo> /ruta/app && cd /ruta/app
python3 -m venv venv && venv/bin/pip install -r requirements-worker.txt
venv/bin/python scripts/generate_vapid.py   # solo la primera vez: crea ./vapid_private.pem (600) e imprime la clave pública
cp .env.example .env && chmod 600 .env      # completa los valores
```

- Copia la clave pública impresa en Vercel como `NEXT_PUBLIC_VAPID_PUBLIC_KEY` y en el `.env` como `VAPID_PUBLIC_KEY_EXPECTED`.
- Guarda de inmediato una copia cifrada de `vapid_private.pem` fuera del VPS (ver [Clave VAPID](#clave-vapid)).

Arranca el worker con pm2 y deja la rotación de logs instalada:

```
npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 startOrReload deploy/ecosystem.config.js && pm2 save
pm2 startup                                  # ejecuta el comando que imprime para arrancar tras un reinicio
```

`deploy/ecosystem.config.js` calcula las rutas desde su propia ubicación: usa `worker.py` y `venv/bin/python` de la carpeta del proyecto, con logs con fecha y reinicio automático.

### 3. Vercel

- **Framework Preset:** Next.js. **Root Directory:** `web`.
- Carga las variables de la tabla de Vercel y despliega.

### 4. Usuarios e invitaciones

- La primera vez que entras con la cuenta de `ADMIN_MOODLE_USERNAME` quedas como administrador sin código.
- En **Admin** creas códigos de invitación de un solo uso, con vencimiento opcional.
- En **Notificaciones** cada usuario activa los avisos nativos en su celular o computadora. En iPhone (iOS 16.4 o superior) primero hay que añadir la web a la pantalla de inicio desde Safari.
- En **Mi cuenta** queda ntfy como canal opcional, con un interruptor para apagarlo y evitar avisos duplicados.
- En **Recordatorios → Horario de clases** cada usuario sube el PDF "Horario de clases" del SGA. La web lo lee, muestra una vista previa y guarda solo las clases (no guarda el PDF, el nombre ni la cédula). Luego elige avisos 30 min, 1 hora o 3 horas antes de cada clase.
- La contraseña de la UTM nunca se guarda: solo se guarda el token de la API de Moodle de cada usuario.

---

## Deploy runbook

Orden: **esquema → worker → web**. Haz el respaldo antes de tocar nada.

1. Detén el worker y respalda su base local:
   ```
   cd /ruta/app
   pm2 stop utm-moodle-tracker
   cp moodle_tasks.db moodle_tasks.db.bak
   ```
2. Aplica `supabase_schema.sql` a mano en el SQL Editor. Se puede ejecutar de nuevo sin riesgo.
3. Trae el código nuevo.
   - **VPS con `git clone`:**
     ```
     git rev-parse HEAD > ../app.prev-commit   # para el rollback
     git pull --ff-only
     ```
   - **VPS con copia de archivos:** primero respalda la carpeta (`cp -a /ruta/app /ruta/app.bak`). Luego copia encima los archivos nuevos sin tocar `.env`, `venv/`, `*.pem` ni `*.db`.
4. Instala las dependencias fijadas:
   ```
   venv/bin/pip install -r requirements-worker.txt
   ```
5. Arranca la versión nueva:
   ```
   pm2 startOrReload deploy/ecosystem.config.js && pm2 save
   ```
   Si el proceso se creó antes con `pm2 start worker.py ...`, la primera vez ejecuta antes `pm2 delete utm-moodle-tracker`. Así pm2 toma las opciones del archivo de configuración.
6. Revisa `pm2 logs utm-moodle-tracker --lines 50` y la tarjeta **Estado del servicio** en `/admin`.
7. Despliega la web: con la integración de Git, se hace sola al fusionar en `main`. Si no, ejecuta `vercel --prod` desde la raíz del repositorio.

**Rollback:**

1. Detén el worker: `pm2 stop utm-moodle-tracker`.
2. Vuelve al código anterior:
   - Con git: `git checkout $(cat ../app.prev-commit)`. Queda en un commit suelto: antes del próximo deploy vuelve a la rama con `git checkout main`.
   - Con copia de archivos: `mv /ruta/app /ruta/app.fallido && mv /ruta/app.bak /ruta/app`.
3. Restaura la base local: `cp moodle_tasks.db.bak moodle_tasks.db`.
4. Reinstala las dependencias: `venv/bin/pip install -r requirements-worker.txt`.
5. Arranca de nuevo: `pm2 restart utm-moodle-tracker`. Usa `restart` y no el archivo de configuración: una versión anterior puede no tener `deploy/ecosystem.config.js`, y pm2 conserva la definición del proceso.

Los cambios de `supabase_schema.sql` agregan columnas y funciones (`IF NOT EXISTS`), así que normalmente no hace falta revertir el SQL.

---

## Si los avisos dejan de llegar

1. Abre `/admin` y revisa **Estado del servicio**. Ahí ves si el worker sigue vivo (late cada ciclo), si Web Push está activo y por qué no, y si la clave VAPID coincide con la de la web.
2. En el VPS, revisa el proceso:
   ```
   pm2 status
   pm2 logs utm-moodle-tracker --lines 200
   ```
   Si falta la configuración de la base o de VAPID, el worker lo avisa en voz alta al arrancar y sigue en modo degradado. Con `WORKER_STRICT=1`, en cambio, se detiene y pm2 lo marca como `errored`.
3. **Claves VAPID distintas:** si la web y el worker usan claves diferentes, ningún dispositivo recibe avisos. Comprueba que `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (Vercel), `VAPID_PUBLIC_KEY_EXPECTED` (`.env`) y la clave pública del PEM sean iguales. Para obtener la clave pública del PEM sin mostrar la privada:
   ```
   venv/bin/python -c "import base64;from cryptography.hazmat.primitives import serialization as s;k=s.load_pem_private_key(open('vapid_private.pem','rb').read(),None);print(base64.urlsafe_b64encode(k.public_key().public_bytes(s.Encoding.X962,s.PublicFormat.UncompressedPoint)).rstrip(b'=').decode())"
   ```
4. Para un usuario concreto: en **Notificaciones**, **Enviar prueba**. En **Avisos**, cada entrada muestra si el push falló.
5. Si configuraste `HEALTHCHECK_URL`, el servicio de monitoreo avisa cuando el worker deja de responder o informa fallos.

---

## Clave VAPID

- La clave privada (`vapid_private.pem`) se genera **una sola vez** y vive solo en el VPS. Guarda una copia **cifrada** fuera del VPS, por ejemplo en tu gestor de contraseñas.
- **Nunca** ejecutes `scripts/generate_vapid.py --force` en un despliegue en uso. Una clave nueva invalida todas las suscripciones, y cada usuario tendría que volver a activar las notificaciones.
- Define `VAPID_PUBLIC_KEY_EXPECTED` en el `.env`. Así un PEM equivocado desactiva Web Push con un mensaje claro, en vez de fallar en silencio.
- Para restaurar la clave, copia el PEM de vuelta, ejecuta `chmod 600 vapid_private.pem` y luego `pm2 restart utm-moodle-tracker`.

---

## Respaldo opcional de la base

La instancia es compartida con Mineral, así que respalda **solo** las tablas `moodle_*`:

```
pg_dump "$DATABASE_URL" -Fc --table='public.moodle_*' -f /backups/moodle_$(date +%F).dump
find /backups -name 'moodle_*.dump' -mtime +14 -delete     # retención de 14 días
```

Copia los archivos fuera del VPS. Para restaurar, usa `pg_restore` solo sobre esas tablas y con cuidado: es una base compartida. Programarlo con cron queda a criterio del dueño.

---

## Vercel

- Hoy el proyecto está vinculado con la CLI desde la **raíz del repositorio** (carpeta `.vercel/`), con Root Directory `web`. El `.vercelignore` de la raíz evita subir el worker, los datos, las claves y los archivos de escritorio.
- Lo recomendado es la **integración de Git** (Root Directory `web`): cada pull request tiene su preview y `main` se publica sola. Conéctala desde el panel de Vercel.
- Protege `main` en GitHub y exige que pase CI antes de fusionar. Se configura en el panel de GitHub.
- La región de las funciones está **pendiente**: hay que medir la latencia hacia el Supabase y el VPS antes de fijarla.

---

## Archivos heredados (escritorio y WhatsApp)

`app.py`, `build_exe.py`, `compilar_exe.bat`, `iniciar.bat`, `iniciar_todo.bat`, `iniciar_whatsapp.bat`, `MoodleTracker.exe`, `icon.ico`, `icon.png` y `whatsapp_bot/` son de la versión de escritorio para Windows, anterior a la web. Ya **no forman parte del producto**:

- No se mantienen.
- CI no los prueba.
- `.vercelignore` los excluye.

Se conservan solo como referencia. El worker y la web no dependen de ellos.
