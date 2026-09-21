import hashlib
import re
import urllib.parse
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from bs4 import BeautifulSoup
import requests


class MoodleClient:
    """Cliente HTTP para interactuar con Moodle mediante cookies de sesión."""

    def __init__(self, base_url: str, session_cookie: str):
        self.base_url = base_url.rstrip("/")
        self.session_cookie = session_cookie.strip()
        self.http = requests.Session()
        self.http.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        })
        self._apply_cookies()

    def _apply_cookies(self):
        """Parsea e inserta la cookie en la sesión."""
        self.http.cookies.clear()
        if not self.session_cookie:
            return

        parsed_url = urllib.parse.urlparse(self.base_url)
        domain = parsed_url.hostname or ""

        # Si el usuario pegó el formato completo "clave1=valor1; clave2=valor2"
        if "=" in self.session_cookie:
            parts = self.session_cookie.split(";")
            for part in parts:
                if "=" in part:
                    k, v = part.strip().split("=", 1)
                    self.http.cookies.set(k.strip(), v.strip(), domain=domain)
        else:
            # Si solo pegó el token de MoodleSession
            self.http.cookies.set("MoodleSession", self.session_cookie, domain=domain)

    def test_connection(self) -> Tuple[bool, str]:
        """Comprueba si la cookie es válida y si la sesión está activa."""
        if not self.session_cookie:
            return False, "No se ha ingresado ninguna cookie de sesión."
        if not self.base_url:
            return False, "No se ha especificado la URL de Moodle."

        try:
            # Consultar la página principal o área personal
            url = f"{self.base_url}/my/"
            resp = self.http.get(url, timeout=12, allow_redirects=True)

            if resp.status_code != 200:
                return False, f"Servidor respondió con código HTTP {resp.status_code}"

            # Detectar si fue redirigido a la pantalla de login
            final_url = resp.url.lower()
            if "login/index.php" in final_url or "login" in final_url and "sesskey" not in final_url:
                return False, "La cookie ha caducado o es inválida (Moodle redirigió a Login)."

            soup = BeautifulSoup(resp.text, "html.parser")

            # Buscar indicios de login exitoso (nombre de usuario, barra de perfil, logout)
            user_elem = soup.select_one(".userbutton, .usertext, .user-name, [data-user-id]")
            user_name = user_elem.get_text(strip=True) if user_elem else None

            # Si encontramos link de logout, la sesión está definitivamente activa
            logout_elem = soup.select_one("a[href*='login/logout.php']")
            if logout_elem or user_name:
                display_name = user_name or "Estudiante autenticado"
                return True, f"Conexión exitosa. Sesión activa: {display_name}"

            # Verificación adicional en el calendario
            cal_url = f"{self.base_url}/calendar/view.php?view=upcoming"
            resp_cal = self.http.get(cal_url, timeout=12, allow_redirects=True)
            if "login" not in resp_cal.url.lower() and resp_cal.status_code == 200:
                return True, "Conexión exitosa al calendario de Moodle."

            return False, "No se pudo confirmar la sesión activa. Verifica tu cookie."

        except requests.exceptions.RequestException as e:
            return False, f"Error de red o conexión: {str(e)}"

    def fetch_upcoming_tasks(self) -> Tuple[bool, List[Dict], str]:
        """
        Extrae las tareas próximas del calendario de Moodle (/calendar/view.php?view=upcoming)
        Retorna: (éxito, lista_de_tareas, mensaje)
        """
        valid, msg = self.test_connection()
        if not valid:
            return False, [], msg

        try:
            # 1. Consultar vista de eventos próximos
            cal_url = f"{self.base_url}/calendar/view.php?view=upcoming"
            resp = self.http.get(cal_url, timeout=15)
            if resp.status_code != 200:
                return False, [], f"Error HTTP {resp.status_code} al consultar calendario."

            soup = BeautifulSoup(resp.text, "html.parser")
            tasks = []

            # Moodle agrupa eventos en contenedores .event o divs con atributo data-region="event-item"
            event_nodes = soup.select(".event, [data-region='event-item'], .calendar-event, .card.event")

            for node in event_nodes:
                task = self._parse_event_node(node)
                if task:
                    tasks.append(task)

            # Si no encontró en vista de eventos, intentar extraer de la vista de meses o área personal
            if not tasks:
                tasks = self._fallback_parse_my_overview(soup)

            return True, tasks, f"Se encontraron {len(tasks)} tareas o eventos próximos."

        except Exception as e:
            return False, [], f"Error al procesar tareas de Moodle: {str(e)}"

    def _parse_event_node(self, node) -> Optional[Dict]:
        """Parsea un nodo de evento del calendario de Moodle."""
        try:
            # Omitir eventos de asistencia
            event_component = (node.get("data-event-component") or "").lower()
            event_type = (node.get("data-event-eventtype") or "").lower()
            if "attendance" in event_component or "attendance" in event_type:
                return None

            # 1. Título
            title_elem = node.select_one(".name, h3, .event-title")
            title = title_elem.get_text(strip=True) if title_elem else node.get("data-event-title", "Sin título")

            title_lower = title.lower()
            if "asistencia" in title_lower or "attendance" in title_lower:
                return None

            # 2. Enlace directo a la actividad
            link_elem = node.select_one(".card-footer a.card-link, a[href*='/mod/']")
            if not link_elem:
                link_elem = node.select_one("a[href*='view.php']")
            task_url = link_elem["href"] if link_elem and link_elem.has_attr("href") else ""

            if "/mod/attendance/" in task_url.lower():
                return None

            # Asegurar URL absoluta
            if task_url and not task_url.startswith("http"):
                task_url = urllib.parse.urljoin(self.base_url, task_url)

            # 3. Materia / Curso
            course = "Materia no especificada"
            course_elem = node.select_one(".course, [data-type='course'], .course-name, a[href*='course/view.php']")
            if course_elem:
                course = course_elem.get_text(strip=True)
            else:
                meta_elem = node.select_one(".dimmed_text, .text-muted, .location")
                if meta_elem:
                    meta_txt = meta_elem.get_text(strip=True)
                    if meta_txt:
                        course = meta_txt

            # 4. Fecha y hora
            date_str = ""
            base_ts = 0
            day_link = node.select_one("a[href*='view=day'], a[href*='time=']")
            if day_link:
                parent_col = day_link.find_parent(".col-11") or day_link.find_parent("div")
                if parent_col:
                    date_str = parent_col.get_text(" ", strip=True).replace("»", "-")
                if "time=" in day_link.get("href", ""):
                    try:
                        qs = urllib.parse.parse_qs(urllib.parse.urlparse(day_link["href"]).query)
                        if "time" in qs:
                            base_ts = int(qs["time"][0])
                    except Exception:
                        pass

            if not date_str:
                date_elem = node.select_one(".date, .event-date, time, .calendar-event-date")
                if date_elem:
                    date_str = date_elem.get_text(" ", strip=True)

            timestamp = self._parse_moodle_date(date_str, base_ts)

            # 5. Generar ID único
            raw_id_src = task_url or f"{title}_{course}_{date_str}"
            task_id = hashlib.md5(raw_id_src.encode("utf-8")).hexdigest()

            # 6. Estado de entrega
            status = "pending"
            status_text = node.get_text().lower()
            if "entregado" in status_text or "submitted" in status_text or "enviado para calificar" in status_text:
                status = "submitted"

            return {
                "id": task_id,
                "title": title,
                "course": course,
                "due_date_str": date_str or "Sin fecha límite indicada",
                "due_timestamp": timestamp,
                "task_url": task_url or f"{self.base_url}/calendar/view.php",
                "status": status,
            }
        except Exception:
            return None

    def _fallback_parse_my_overview(self, soup: BeautifulSoup) -> List[Dict]:
        """Intenta extraer enlaces de actividades directamente de la página si no usa la plantilla estándar."""
        tasks = []
        assign_links = soup.select("a[href*='mod/assign/view.php'], a[href*='mod/quiz/view.php']")
        for a in assign_links:
            title = a.get_text(strip=True)
            if not title or len(title) < 3 or "asistencia" in title.lower() or "attendance" in title.lower():
                continue

            task_id = hashlib.md5(url.encode("utf-8")).hexdigest()
            tasks.append({
                "id": task_id,
                "title": title,
                "course": "Campus Virtual Moodle",
                "due_date_str": "Ver en Moodle",
                "due_timestamp": 0,
                "task_url": url,
                "status": "pending",
            })
        return tasks

    def _parse_moodle_date(self, date_str: str, base_ts: int = 0) -> int:
        """Convierte una cadena de fecha de Moodle a timestamp UNIX aproximado."""
        if not date_str:
            return 0

        lower = date_str.lower()
        now = datetime.now()

        try:
            # Buscar patrones de hora HH:MM
            time_match = re.search(r"(\d{1,2}):(\d{2})", lower)
            hour, minute = (23, 59)
            if time_match:
                hour = int(time_match.group(1))
                minute = int(time_match.group(2))

            if "hoy" in lower or "today" in lower:
                target_dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                return int(target_dt.timestamp())

            if "mañana" in lower or "tomorrow" in lower:
                target_dt = (now + timedelta(days=1)).replace(hour=hour, minute=minute, second=0, microsecond=0)
                return int(target_dt.timestamp())

            # Buscar día y mes: "25 de septiembre" o "25 sep"
            meses = {
                "enero": 1, "ene": 1, "febrero": 2, "feb": 2, "marzo": 3, "mar": 3,
                "abril": 4, "abr": 4, "mayo": 5, "may": 5, "junio": 6, "jun": 6,
                "julio": 7, "jul": 7, "agosto": 8, "ago": 8, "septiembre": 9, "sep": 9,
                "octubre": 10, "oct": 10, "noviembre": 11, "nov": 11, "diciembre": 12, "dic": 12
            }
            for mes_nombre, mes_num in meses.items():
                match = re.search(rf"(\d{{1,2}})\s+(?:de\s+)?{mes_nombre}", lower)
                if match:
                    dia = int(match.group(1))
                    year = now.year
                    target_dt = datetime(year, mes_num, dia, hour, minute)
                    if target_dt < now - timedelta(days=60):
                        target_dt = target_dt.replace(year=year + 1)
                    return int(target_dt.timestamp())

            if base_ts > 0:
                dt_base = datetime.fromtimestamp(base_ts)
                dt_res = dt_base.replace(hour=hour, minute=minute, second=0, microsecond=0)
                return int(dt_res.timestamp())

        except Exception:
            pass

        return 0
