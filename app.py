import os
import sys
import subprocess
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime
from typing import Dict, List, Optional
import tkinter as tk
from tkinter import messagebox
import customtkinter as ctk
from PIL import Image

from moodle_client import MoodleClient
from notifier import TaskNotificationManager, send_windows_notification
from storage import Storage


def resource_path(relative_path: str) -> str:
    """Obtiene la ruta absoluta al recurso, compatible con PyInstaller y entorno local."""
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_path, relative_path)


# Configuración de apariencia
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class MoodleTrackerApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        # Configuración de ventana
        self.title("🎓 Moodle Task Tracker - Avisos Universitarios")
        self.geometry("820x760")
        self.minsize(740, 600)

        # Configurar icono nativo
        ico_file = resource_path("icon.ico")
        if os.path.exists(ico_file):
            try:
                self.iconbitmap(ico_file)
            except Exception:
                pass

        # Inicializar almacenamiento local
        self.storage = Storage()

        # Variables de control
        self.search_var = ctk.StringVar(value="")
        self.search_var.trace_add("write", lambda *args: self._render_tasks())
        self.is_syncing = False
        self._stop_bg_thread = threading.Event()

        # Construcción visual
        self._build_ui()

        # Cargar tareas guardadas localmente
        self._render_tasks()

        # Iniciar sincronización inicial e hilo de monitoreo en segundo plano
        self.after(800, self._auto_sync_first_time)
        self._start_background_monitor()

        # Cierre seguro
        self.protocol("WM_DELETE_WINDOW", self._on_closing)

    def _build_ui(self):
        # Contenedor raíz
        self.main_container = ctk.CTkFrame(self, fg_color="transparent")
        self.main_container.pack(fill="both", expand=True, padx=24, pady=18)

        # 1. Cabecera (Logo, Título, Badge de Estado)
        header_frame = ctk.CTkFrame(self.main_container, fg_color="transparent")
        header_frame.pack(fill="x", pady=(0, 14))

        title_box = ctk.CTkFrame(header_frame, fg_color="transparent")
        title_box.pack(side="left")

        png_file = resource_path("icon.png")
        if os.path.exists(png_file):
            try:
                logo_img = Image.open(png_file)
                self.logo_ctk = ctk.CTkImage(light_image=logo_img, dark_image=logo_img, size=(44, 44))
                logo_lbl = ctk.CTkLabel(title_box, image=self.logo_ctk, text="")
                logo_lbl.pack(side="left", padx=(0, 12))
            except Exception:
                pass

        text_box = ctk.CTkFrame(title_box, fg_color="transparent")
        text_box.pack(side="left")

        lbl_title = ctk.CTkLabel(
            text_box,
            text="Moodle Task Tracker",
            font=ctk.CTkFont(size=22, weight="bold"),
            text_color="#F9FAFB",
        )
        lbl_title.pack(anchor="w")

        self.lbl_subtitle = ctk.CTkLabel(
            text_box,
            text="Monitoreo y alertas automáticas de tareas universitarias",
            font=ctk.CTkFont(size=12),
            text_color="#9CA3AF",
        )
        self.lbl_subtitle.pack(anchor="w")

        right_box = ctk.CTkFrame(header_frame, fg_color="transparent")
        right_box.pack(side="right")

        self.status_badge = ctk.CTkLabel(
            right_box,
            text="● VERIFICANDO",
            font=ctk.CTkFont(size=12, weight="bold"),
            fg_color="#1E293B",
            text_color="#38BDF8",
            corner_radius=12,
            padx=14,
            pady=5,
        )
        self.status_badge.pack(anchor="e")

        self.lbl_last_checked = ctk.CTkLabel(
            right_box,
            text="Última sincronización: Esperando...",
            font=ctk.CTkFont(size=11),
            text_color="#6B7280",
        )
        self.lbl_last_checked.pack(anchor="e", pady=(3, 0))

        # 2. Barra de Herramientas (Sincronizar, Ajustes, Búsqueda)
        toolbar = ctk.CTkFrame(self.main_container, corner_radius=12, fg_color="#1E202B")
        toolbar.pack(fill="x", pady=8)

        tb_inner = ctk.CTkFrame(toolbar, fg_color="transparent")
        tb_inner.pack(fill="x", padx=14, pady=10)

        self.btn_sync = ctk.CTkButton(
            tb_inner,
            text="🔄 Sincronizar Ahora",
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#10B981",
            hover_color="#059669",
            height=36,
            width=160,
            command=self._trigger_manual_sync,
        )
        self.btn_sync.pack(side="left", padx=(0, 10))

        self.btn_settings = ctk.CTkButton(
            tb_inner,
            text="⚙️ Configurar Cookie & URL",
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#374151",
            hover_color="#4B5563",
            height=36,
            width=190,
            command=self._open_settings_modal,
        )
        self.btn_settings.pack(side="left", padx=(0, 10))

        self.btn_whatsapp = ctk.CTkButton(
            tb_inner,
            text="💬 WhatsApp QR",
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#059669",
            hover_color="#047857",
            height=36,
            width=140,
            command=self._open_whatsapp_landing,
        )
        self.btn_whatsapp.pack(side="left", padx=(0, 12))

        # Buscador
        self.search_entry = ctk.CTkEntry(
            tb_inner,
            placeholder_text="🔍 Filtrar por materia o tarea...",
            textvariable=self.search_var,
            height=36,
            font=ctk.CTkFont(size=12),
        )
        self.search_entry.pack(side="right", fill="x", expand=True)

        # 3. Lista Desplazable de Tareas
        self.tasks_scroll = ctk.CTkScrollableFrame(
            self.main_container,
            fg_color="transparent",
            label_text="📋 TAREAS Y ENTREGAS PENDIENTES",
            label_font=ctk.CTkFont(size=12, weight="bold"),
            label_text_color="#9CA3AF",
        )
        self.tasks_scroll.pack(fill="both", expand=True, pady=(6, 10))

        # 4. Pie de página informativo
        footer_frame = ctk.CTkFrame(self.main_container, fg_color="transparent")
        footer_frame.pack(fill="x")

        self.lbl_footer_info = ctk.CTkLabel(
            footer_frame,
            text="💡 Consejo: Puedes minimizar esta ventana y el programa te enviará alertas de Windows cuando aparezcan tareas nuevas.",
            font=ctk.CTkFont(size=11),
            text_color="#6B7280",
        )
        self.lbl_footer_info.pack(side="left")

    # --- Renderizado de Tarjetas de Tareas ---

    def _render_tasks(self):
        """Limpia y redibuja las tareas en el panel desplazable."""
        for widget in self.tasks_scroll.winfo_children():
            widget.destroy()

        tasks = self.storage.get_all_tasks(order_by_due=True)
        query = self.search_var.get().lower().strip()

        if query:
            tasks = [
                t for t in tasks
                if query in t.get("title", "").lower() or query in t.get("course", "").lower()
            ]

        if not tasks:
            cookie = self.storage.get_setting("moodle_session", "")
            if not cookie:
                empty_box = ctk.CTkFrame(self.tasks_scroll, corner_radius=14, fg_color="#1E202B")
                empty_box.pack(fill="x", pady=20, padx=20)

                lbl_empty = ctk.CTkLabel(
                    empty_box,
                    text="👋 ¡Bienvenido! Aún no has configurado tu sesión de Moodle.\n"
                         "Haz clic en '⚙️ Configurar Cookie & URL' arriba para ingresar tu MoodleSession.",
                    font=ctk.CTkFont(size=13),
                    text_color="#9CA3AF",
                    justify="center",
                )
                lbl_empty.pack(pady=24, padx=20)
            else:
                empty_box = ctk.CTkFrame(self.tasks_scroll, corner_radius=14, fg_color="#1E202B")
                empty_box.pack(fill="x", pady=20, padx=20)

                lbl_empty = ctk.CTkLabel(
                    empty_box,
                    text="🎉 ¡Estás completamente al día!\nNo se encontraron entregas pendientes en tu calendario de Moodle.",
                    font=ctk.CTkFont(size=14, weight="bold"),
                    text_color="#10B981",
                    justify="center",
                )
                lbl_empty.pack(pady=24, padx=20)
            return

        now = int(time.time())
        one_day = now + 86400
        three_days = now + (86400 * 3)

        for task in tasks:
            due = task.get("due_timestamp", 0)

            # Determinar nivel de urgencia y color
            if due > 0 and due <= now:
                color_accent = "#EF4444"  # Vencida
                urgency_badge = "⚠️ VENCIDA / HOY"
            elif due > 0 and due <= one_day:
                color_accent = "#EF4444"  # Vence en <24h
                urgency_badge = "🔥 VENCE PRONTO (<24h)"
            elif due > 0 and due <= three_days:
                color_accent = "#F59E0B"  # Vence en 3 días
                urgency_badge = "⏳ PRÓXIMOS DÍAS"
            else:
                color_accent = "#10B981"  # Con tiempo
                urgency_badge = "📅 PENDIENTE"

            # Tarjeta contenedor
            card = ctk.CTkFrame(self.tasks_scroll, corner_radius=12, fg_color="#1A1C26")
            card.pack(fill="x", pady=6, padx=4)

            # Borde de acento izquierdo
            bar = ctk.CTkFrame(card, width=5, corner_radius=3, fg_color=color_accent)
            bar.pack(side="left", fill="y", padx=(6, 12), pady=6)

            content = ctk.CTkFrame(card, fg_color="transparent")
            content.pack(side="left", fill="both", expand=True, pady=10, padx=(0, 10))

            # Fila 1: Materia + Badge de Urgencia
            meta_row = ctk.CTkFrame(content, fg_color="transparent")
            meta_row.pack(fill="x", pady=(0, 4))

            course_name = task.get("course") or "Materia General"
            lbl_course = ctk.CTkLabel(
                meta_row,
                text=course_name,
                font=ctk.CTkFont(size=11, weight="bold"),
                fg_color="#1E293B",
                text_color="#60A5FA",
                corner_radius=6,
                padx=8,
                pady=2,
            )
            lbl_course.pack(side="left")

            lbl_urgency = ctk.CTkLabel(
                meta_row,
                text=urgency_badge,
                font=ctk.CTkFont(size=10, weight="bold"),
                text_color=color_accent,
                padx=8,
            )
            lbl_urgency.pack(side="left", padx=6)

            # Fila 2: Título de la tarea
            lbl_task_title = ctk.CTkLabel(
                content,
                text=task.get("title", "Sin título"),
                font=ctk.CTkFont(size=14, weight="bold"),
                text_color="#F3F4F6",
                anchor="w",
                justify="left",
                wraplength=480,
            )
            lbl_task_title.pack(fill="x", pady=(2, 4))

            # Fila 3: Fecha de entrega
            date_str = task.get("due_date_str") or "Fecha no especificada"
            lbl_date = ctk.CTkLabel(
                content,
                text=f"⏱️ Límite: {date_str}",
                font=ctk.CTkFont(size=12),
                text_color="#9CA3AF",
                anchor="w",
            )
            lbl_date.pack(fill="x")

            # Columna derecha: Botón de acción para abrir en el navegador
            action_box = ctk.CTkFrame(card, fg_color="transparent")
            action_box.pack(side="right", padx=14, pady=10)

            url = task.get("task_url", "")
            btn_open = ctk.CTkButton(
                action_box,
                text="Abrir ↗",
                font=ctk.CTkFont(size=12, weight="bold"),
                fg_color="#2563EB",
                hover_color="#1D4ED8",
                width=90,
                height=34,
                command=lambda u=url: webbrowser.open(u) if u else None,
            )
            btn_open.pack(side="right")

    # --- Sincronización y Monitoreo ---

    def _auto_sync_first_time(self):
        cookie = self.storage.get_setting("moodle_session", "")
        if cookie:
            self._sync_tasks_background(is_manual=False)
        else:
            self.status_badge.configure(
                text="● REQUIERE COOKIE",
                fg_color="#374151",
                text_color="#FBBF24",
            )

    def _trigger_manual_sync(self):
        if self.is_syncing:
            return
        self._sync_tasks_background(is_manual=True)

    def _sync_tasks_background(self, is_manual: bool = False):
        """Lanza la sincronización en un hilo aparte para no congelar la UI."""
        if self.is_syncing:
            return
        self.is_syncing = True

        self.status_badge.configure(
            text="● SINCRONIZANDO...",
            fg_color="#0C4A6E",
            text_color="#38BDF8",
        )
        self.btn_sync.configure(state="disabled", text="⏳ Buscando...")

        threading.Thread(target=self._worker_sync, args=(is_manual,), daemon=True).start()

    def _worker_sync(self, is_manual: bool):
        base_url = self.storage.get_setting("moodle_url", "https://evirtual.utm.edu.ec")
        session_cookie = self.storage.get_setting("moodle_session", "")

        if not session_cookie:
            self.after(0, lambda: self._on_sync_done(False, [], "Ingresa tu MoodleSession en Configuración.", is_manual))
            return

        client = MoodleClient(base_url, session_cookie)
        success, tasks, msg = client.fetch_upcoming_tasks()

        self.after(0, lambda: self._on_sync_done(success, tasks, msg, is_manual))

    def _on_sync_done(self, success: bool, tasks: List[Dict], msg: str, is_manual: bool):
        self.is_syncing = False
        self.btn_sync.configure(state="normal", text="🔄 Sincronizar Ahora")
        now_str = datetime.now().strftime("%H:%M:%S")

        if success:
            new_tasks, _ = self.storage.save_tasks(tasks)
            self.storage.set_setting("last_checked", now_str)

            self.status_badge.configure(
                text="● CONECTADO",
                fg_color="#064E3B",
                text_color="#34D399",
            )
            self.lbl_last_checked.configure(text=f"Última sincronización: Hoy {now_str}")

            # Disparar recordatorios por hitos (nueva, 3 días, 2 días, 1 día, 8 horas)
            auto_notify = self.storage.get_setting("auto_notify", "1") == "1"
            if auto_notify:
                TaskNotificationManager.process_milestones(tasks, self.storage, new_tasks=new_tasks)

            self._render_tasks()

            if is_manual:
                messagebox.showinfo("Sincronización Exitosa", f"{msg}\n\nNuevas tareas detectadas: {len(new_tasks)}")
        else:
            self.status_badge.configure(
                text="● ERROR SESIÓN",
                fg_color="#7F1D1D",
                text_color="#F87171",
            )
            if is_manual:
                messagebox.showwarning("Atención", f"No se pudo sincronizar:\n{msg}\n\nVerifica si tu cookie ha caducado.")

    def _start_background_monitor(self):
        """Hilo en bucle que realiza chequeos periódicos cada N minutos."""
        def monitor_loop():
            while not self._stop_bg_thread.is_set():
                try:
                    mins = int(self.storage.get_setting("check_interval_mins", "30"))
                except ValueError:
                    mins = 30

                # Esperar el intervalo en bloques de 5 segundos para responder rápido al cierre
                for _ in range(mins * 12):
                    if self._stop_bg_thread.is_set():
                        return
                    time.sleep(5)

                # Ejecutar sincronización en segundo plano
                if not self._stop_bg_thread.is_set():
                    self.after(0, lambda: self._sync_tasks_background(is_manual=False))

        t = threading.Thread(target=monitor_loop, daemon=True)
        t.start()

    # --- Modal de Configuración ---

    def _open_settings_modal(self):
        modal = ctk.CTkToplevel(self)
        modal.title("⚙️ Configuración de Moodle y Notificaciones")
        modal.geometry("540x600")
        modal.resizable(False, False)
        modal.grab_set()

        container = ctk.CTkFrame(modal, fg_color="transparent")
        container.pack(fill="both", expand=True, padx=22, pady=18)

        lbl_modal_title = ctk.CTkLabel(
            container,
            text="Ajustes de Conexión y Notificaciones",
            font=ctk.CTkFont(size=18, weight="bold"),
            text_color="#F3F4F6",
        )
        lbl_modal_title.pack(anchor="w", pady=(0, 14))

        # 1. URL de Moodle
        lbl_url = ctk.CTkLabel(
            container,
            text="🌐 URL del Campus Virtual (Moodle):",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#E5E7EB",
        )
        lbl_url.pack(anchor="w", pady=(4, 2))

        entry_url = ctk.CTkEntry(
            container,
            height=36,
            font=ctk.CTkFont(size=12),
        )
        entry_url.insert(0, self.storage.get_setting("moodle_url", "https://evirtual.utm.edu.ec"))
        entry_url.pack(fill="x", pady=(0, 12))

        # 2. Cookie MoodleSession
        lbl_cookie = ctk.CTkLabel(
            container,
            text="🍪 Cookie MoodleSession:",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#E5E7EB",
        )
        lbl_cookie.pack(anchor="w", pady=(4, 2))

        entry_cookie = ctk.CTkEntry(
            container,
            height=36,
            placeholder_text="Pega aquí el valor de MoodleSession...",
            font=ctk.CTkFont(size=12),
        )
        current_cookie = self.storage.get_setting("moodle_session", "")
        if current_cookie:
            entry_cookie.insert(0, current_cookie)
        entry_cookie.pack(fill="x", pady=(0, 12))

        # 3. Frecuencia de Monitoreo
        lbl_interval = ctk.CTkLabel(
            container,
            text="⏱️ Frecuencia de Chequeo en Segundo Plano:",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color="#E5E7EB",
        )
        lbl_interval.pack(anchor="w", pady=(4, 2))

        current_int = self.storage.get_setting("check_interval_mins", "30")
        seg_interval = ctk.CTkSegmentedButton(
            container,
            values=["15 min", "30 min", "60 min", "120 min"],
        )
        seg_interval.set(f"{current_int} min" if f"{current_int} min" in ["15 min", "30 min", "60 min", "120 min"] else "30 min")
        seg_interval.pack(fill="x", pady=(0, 14))

        # 4. Checkbox de Notificaciones
        notify_val = ctk.BooleanVar(value=self.storage.get_setting("auto_notify", "1") == "1")
        chk_notify = ctk.CTkCheckBox(
            container,
            text="Activar recordatorios automáticos (Nueva, 3d, 2d, 1d y 8h)",
            variable=notify_val,
            font=ctk.CTkFont(size=12),
        )
        chk_notify.pack(anchor="w", pady=(0, 16))

        # Tarjeta explicativa para sacar la cookie
        help_card = ctk.CTkFrame(container, corner_radius=10, fg_color="#1A1C26")
        help_card.pack(fill="x", pady=(0, 16))

        help_text = (
            "📌 ¿Cómo copiar tu cookie en 15 segundos?\n"
            "1. Abre Moodle en Chrome o Edge donde ya iniciaste sesión.\n"
            "2. Presiona F12 (Herramientas de Desarrollador).\n"
            "3. Ve a la pestaña 'Application' (o 'Almacenamiento') > 'Cookies'.\n"
            "4. Busca la fila llamada 'MoodleSession' y copia su valor aquí."
        )
        lbl_help = ctk.CTkLabel(
            help_card,
            text=help_text,
            font=ctk.CTkFont(size=11),
            text_color="#9CA3AF",
            justify="left",
        )
        lbl_help.pack(padx=14, pady=10)

        # Botones de acción del modal
        btn_box = ctk.CTkFrame(container, fg_color="transparent")
        btn_box.pack(fill="x")

        def save_and_close():
            url = entry_url.get().strip()
            cookie = entry_cookie.get().strip()
            interval_str = seg_interval.get().replace(" min", "").strip()

            if not url:
                messagebox.showwarning("Campo Vacío", "Por favor ingresa la URL de Moodle.")
                return

            self.storage.set_setting("moodle_url", url)
            self.storage.set_setting("moodle_session", cookie)
            self.storage.set_setting("check_interval_mins", interval_str)
            self.storage.set_setting("auto_notify", "1" if notify_val.get() else "0")

            modal.destroy()
            self._sync_tasks_background(is_manual=True)

        btn_save = ctk.CTkButton(
            btn_box,
            text="Guardar y Probar Conexión",
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#10B981",
            hover_color="#059669",
            height=38,
            command=save_and_close,
        )
        btn_save.pack(fill="x")

    def _open_whatsapp_landing(self):
        """Abre la landing de WhatsApp y arranca el servidor Node si no está activo."""
        server_running = False
        try:
            res = urllib.request.urlopen("http://localhost:3000/api/status", timeout=1)
            server_running = (res.status == 200)
        except Exception:
            pass

        if not server_running:
            bot_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whatsapp_bot")
            server_file = os.path.join(bot_dir, "server.js")
            if os.path.exists(server_file):
                try:
                    creationflags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                    subprocess.Popen(["node", "server.js"], cwd=bot_dir, creationflags=creationflags)
                    time.sleep(1.2)
                except Exception as e:
                    print("[WhatsApp Launcher Error]:", e)

        webbrowser.open("http://localhost:3000")

    def _on_closing(self):
        self._stop_bg_thread.set()
        self.destroy()


if __name__ == "__main__":
    app = MoodleTrackerApp()
    app.mainloop()
