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

La carpeta `web/` contiene una app Next.js protegida con contraseña. Desde ahí se crean recordatorios con una frecuencia (cada N minutos, horas o días) y una fecha de fin. La web solo guarda los datos en Supabase; el worker del VPS los lee y envía las notificaciones por ntfy.

### 1. Supabase
Ejecuta en el SQL Editor la sección `custom_reminders` del archivo `supabase_schema.sql`. La tabla tiene RLS activado y no tiene políticas, así que solo la `service_role` key puede acceder a ella.

### 2. VPS (worker.py)
Agrega esta variable al `.env` del VPS y reinicia el worker:
```
SUPABASE_SERVICE_ROLE_KEY=<service_role key de Supabase>
```
Si no está configurada, el worker usa la key anterior, que no tiene acceso a la tabla, y los recordatorios no se envían.

### 3. Vercel
- **Root Directory:** `web`
- **Environment Variables:** `APP_PASSWORD`, `SESSION_SECRET` (un texto aleatorio largo, por ejemplo `openssl rand -hex 32`), `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. No uses el prefijo `NEXT_PUBLIC_` en ninguna.

### Desarrollo local
```
cd web
cp .env.example .env.local   # completa los valores
npm install
npm run dev
```
