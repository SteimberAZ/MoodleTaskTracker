# 🎓 Moodle Task Tracker (Desktop)

Aplicación de escritorio moderna para **Windows** diseñada para monitorear y alertar automáticamente sobre **nuevas tareas y fechas límite de Moodle**, asegurando que nunca se te pase ninguna entrega universitaria.

---

## ✨ Características Principales

- **Inicio de Sesión Fácil con Cookies**:
  - No requiere credenciales ni lidiar con autenticación en dos pasos (2FA), SSO institucional o CAPTCHAs. Solo necesitas tu cookie `MoodleSession`.
- **Monitoreo Automático en Segundo Plano**:
  - Verifica silenciosamente el calendario de Moodle cada 15, 30 o 60 minutos.
- **Sistema de Recordatorios Escalonados (5 Hitos)**:
  - 🔔 **Nueva Tarea**: Notificación inmediata apenas un profesor publica una tarea en Moodle.
  - 📅 **Faltan 3 Días**: Primer recordatorio preventivo para planificar tu entrega.
  - ⏳ **Faltan 2 Días**: Segundo aviso para avanzar en el trabajo.
  - ⚠️ **Falta 1 Día**: Alerta de atención prioritaria (vence en 24 horas).
  - 🚨 **Faltan 8 Horas**: Alerta urgente crítica de última oportunidad.
  - *Cada hito se registra en la base de datos local SQLite para garantizar que nunca recibas alertas duplicadas ni spam repetitivo.*
- **Alertas Duales Simultáneas**:
  - 🖥️ **Windows Toasts**: Notificaciones flotantes nativas en tu escritorio.
  - 📱 **WhatsApp Personal**: Mensajes directos a tu chat ("Note to Self") con el nombre de la materia, fecha de entrega y enlace directo a la tarea.
- **Tarjetas Visuales de Tareas**:
  - Código de color por urgencia (Rojo = vence hoy, Amarillo = próximos 3 días, Verde = con tiempo).
  - Chip con el nombre de la materia o curso.
  - Botón directo **"Abrir ↗"** que abre la actividad directamente en tu navegador habitual.
- **Buscador y Filtro Rápido**:
  - Filtra tareas en tiempo real por materia o palabras clave.

---

## 🍪 Cómo Obtener tu Cookie MoodleSession (15 segundos)

1. Abre el campus virtual de tu universidad en Google Chrome o Microsoft Edge donde ya tengas tu sesión iniciada.
2. Presiona la tecla **F12** (o clic derecho > *Inspeccionar*).
3. En las pestañas superiores, ve a **Application** (o *Almacenamiento* / *Aplicación*).
4. En el panel lateral izquierdo, expande **Cookies** y selecciona la URL de tu Moodle.
5. Busca la cookie llamada **`MoodleSession`**, copia su valor y pégalo en la aplicación dentro de **⚙️ Configuración**.

---

## 📱 Vincular Alertas a tu WhatsApp Personal (Landing QR)

Para recibir las alertas directamente a tu teléfono en tu chat personal:

1. Haz doble clic en **`iniciar_whatsapp.bat`** (o pulsa el botón **💬 WhatsApp QR** dentro de la app).
2. Se abrirá la mini landing web en tu navegador:
   ```text
   http://localhost:3000
   ```
3. Verás un código QR dinámico de WhatsApp.
4. Abre **WhatsApp** en tu teléfono móvil > **Menú (tres puntos / Ajustes)** > **Dispositivos vinculados**.
5. Toca en **Vincular un dispositivo** y escanea el código QR de la pantalla.
6. ¡Listo! La landing confirmará: *"¡Conectado exitosamente como +593...!"*.
7. Puedes pulsar el botón **"🚀 Enviar Mensaje de Prueba a mi WhatsApp"** para verificar que te llegue al instante.

---

## 🎮 Cómo Iniciar Todo

### Modo Completo (Moodle Desktop + Alertas a WhatsApp):
Haz doble clic en:
```text
iniciar_todo.bat
```
*Inicia el microservicio de WhatsApp en segundo plano y la app de escritorio Moodle Tracker.*

### Solo App de Escritorio:
Haz doble clic en **`MoodleTracker.exe`**.

---

## 🛠️ Cómo Compilar el .exe con 1 Clic

- **En Windows**: Haz doble clic en **`compilar_exe.bat`**.
- **O con Python**:
  ```bash
  python build_exe.py
  ```
El script instalará las dependencias necesarias, incluirá el icono de alta resolución y generará `MoodleTracker.exe` directamente en la raíz.

---

## ✅ Detección de Tareas Entregadas

En cada sincronización, el worker abre la página de cada tarea pendiente (`/mod/assign/view.php?id=…`) y lee el estado de la entrega. Si la tarea aparece como **"Enviado para calificar"**, queda marcada como `submitted` y no vuelve a generar recordatorios.

## ⏰ Recordatorios Personalizados (Web en Vercel)

La carpeta `web/` contiene una app Next.js multiusuario: cada persona entra con su cuenta de Moodle de la UTM y el registro es solo por código de invitación. Desde ahí se crean recordatorios con una frecuencia (cada N minutos, horas o días) y una fecha de fin. La web solo guarda los datos en Supabase; el worker del VPS los lee y envía las notificaciones por ntfy.

### 1. Base de datos (Supabase self-hosted compartido)
Las tablas del proyecto usan el prefijo `moodle_` y viven en una base compartida. Para no usar la `service_role` key, el acceso pasa por un rol dedicado, `moodle_app`, que solo puede tocar las tablas `moodle_*`.

1. Ejecuta `supabase_schema.sql` completo como administrador, en el SQL Editor de Studio o con `psql`. Es idempotente y no modifica objetos fuera de `moodle_*`.
2. Genera el JWT del rol con el `JWT_SECRET` de la instancia:
   ```
   JWT_SECRET=<jwt secret de la instancia> python scripts/make_moodle_jwt.py --years 5
   ```

### 2. VPS (worker.py)
Variables del `.env`:
```
SUPABASE_URL=https://<dominio del supabase>
SUPABASE_ANON_KEY=<anon key de la instancia>
MOODLE_DB_JWT=<JWT generado en el paso anterior>
NTFY_TOPIC=<tu topic>
MOODLE_URL=https://evirtual.utm.edu.ec
VAPID_SUBJECT=mailto:<tu correo>
# VAPID_PRIVATE_KEY_FILE=./vapid_private.pem   (valor por defecto)
```
El worker recorre a todos los usuarios activos de `moodle_users`, sincroniza sus tareas con su token de Moodle y les envía los avisos como **notificaciones nativas (Web Push)** a cada dispositivo donde las activaron, y también a su tema de ntfy si el usuario lo dejó encendido en **Mi cuenta**. `NTFY_TOPIC` solo se usa como respaldo para el horario de clases cuando no existe ningún usuario admin. `MOODLE_SESSION` (la cookie) queda como respaldo y solo se usa cuando no hay ningún usuario registrado.

**Notificaciones nativas (Web Push):** la clave privada VAPID se genera una sola vez en el VPS y nunca sale de ahí:
```
python3 -m venv venv && venv/bin/pip install -r requirements-worker.txt
venv/bin/python scripts/generate_vapid.py   # crea ./vapid_private.pem (600) e imprime la clave pública
```
La clave pública impresa va a Vercel como `NEXT_PUBLIC_VAPID_PUBLIC_KEY`. Guarda una copia de `vapid_private.pem` fuera de git: si se pierde, todos los usuarios tienen que volver a activar las notificaciones. Ejecuta el worker con el Python del venv (`pm2 start worker.py --name utm-moodle-tracker --interpreter "$PWD/venv/bin/python"`).

> Orden de despliegue: detén el worker, ejecuta `supabase_schema.sql` y recién después inicia la versión nueva.

### 3. Vercel
- **Framework Preset:** Next.js. **Root Directory:** `web`.
- **Environment Variables:**
  - Obligatorias: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `MOODLE_DB_JWT` y `ADMIN_MOODLE_USERNAME` (tu usuario de la UTM).
  - Opcionales: `ADMIN_NTFY_TOPIC` (tu tema actual de ntfy; si falta, se genera uno aleatorio), `MOODLE_URL`, `NTFY_SERVER` y `SESSION_SECRET`. Si `SESSION_SECRET` no está definida, se deriva automáticamente de `MOODLE_DB_JWT`; definirla solo sirve para cerrar todas las sesiones sin cambiar el JWT.
  - Para las notificaciones nativas: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (la clave **pública** que imprime `generate_vapid.py`; se incrusta al compilar, así que hay que redesplegar después de cargarla).
  - `APP_PASSWORD` ya no se usa. Fuera de `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, ninguna variable lleva el prefijo `NEXT_PUBLIC_`.

### 4. Usuarios e invitaciones
- La primera vez que entras con la cuenta de `ADMIN_MOODLE_USERNAME`, quedas como administrador sin necesidad de código, y tus recordatorios anteriores pasan a tu cuenta.
- En **Admin** creas códigos de invitación de un solo uso, con vencimiento opcional. Cada invitado entra con su usuario de la UTM y su código.
- En **Notificaciones** cada usuario activa los avisos nativos en su celular o computadora. En iPhone (iOS 16.4 o superior) primero hay que añadir la web a la pantalla de inicio desde Safari.
- En **Mi cuenta** sigue el tema de ntfy como canal opcional, con un interruptor para apagarlo y evitar avisos duplicados.
- La contraseña de la UTM nunca se guarda: solo se guarda el token de la API de Moodle de cada usuario.

### Desarrollo local
```
cd web
cp .env.example .env.local   # completa los valores
npm install
npm run dev
```
