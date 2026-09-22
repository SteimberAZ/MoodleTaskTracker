import os
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional
import requests

# Zona horaria de Ecuador (UTM - Portoviejo / Guayaquil: UTC-5)
ECUADOR_TZ = timezone(timedelta(hours=-5))

# Horario académico oficial UTM
# Días: 0=Lunes, 1=Martes, 2=Miércoles, 3=Jueves, 4=Viernes, 5=Sábado, 6=Domingo
CLASS_SCHEDULE: List[Dict] = [
    # LUNES
    {
        "id": "intro_investigacion_lun",
        "day": 0,
        "day_name": "Lunes",
        "subject": "INTRODUCCIÓN A LA INVESTIGACIÓN CIENTÍFICA (EMI)",
        "teacher": "RIVADENEIRA BARREIRO LUCIA BERNARDA",
        "parallel": "B",
        "classroom": "1-59-3-01-A",
        "location": "Aula (Piso 3)",
        "start_time": "07:00",
        "end_time": "09:00",
    },
    # MARTES
    {
        "id": "desarrollo_web_mar",
        "day": 1,
        "day_name": "Martes",
        "subject": "DESARROLLO DE APLICACIONES WEB",
        "teacher": "PARRAGA VALLE JOSE EDUARDO",
        "parallel": "A",
        "classroom": "1-59-1-03-LC",
        "location": "Lab. Computación (Piso 1)",
        "start_time": "07:00",
        "end_time": "09:00",
    },
    {
        "id": "admin_bd_mar",
        "day": 1,
        "day_name": "Martes",
        "subject": "ADMINISTRACIÓN DE BASES DE DATOS",
        "teacher": "BOWEN MENDOZA LORENA ELIZABETH",
        "parallel": "A",
        "classroom": "1-59-2-05-LC",
        "location": "Lab. Computación (Piso 2)",
        "start_time": "09:00",
        "end_time": "11:00",
    },
    # MIÉRCOLES
    {
        "id": "desarrollo_web_mie",
        "day": 2,
        "day_name": "Miércoles",
        "subject": "DESARROLLO DE APLICACIONES WEB",
        "teacher": "PARRAGA VALLE JOSE EDUARDO",
        "parallel": "A",
        "classroom": "1-59-3-08-L",
        "location": "Laboratorio (Piso 3)",
        "start_time": "07:00",
        "end_time": "09:00",
    },
    {
        "id": "calidad_software_mie",
        "day": 2,
        "day_name": "Miércoles",
        "subject": "ASEGURAMIENTO DE CALIDAD DEL SOFTWARE",
        "teacher": "CEVALLOS VILLA GUILLERMO JOSE",
        "parallel": "B",
        "classroom": "1-59-1-01-A",
        "location": "Aula (Piso 1)",
        "start_time": "11:00",
        "end_time": "13:00",
    },
    {
        "id": "tecnicas_simulacion_mie",
        "day": 2,
        "day_name": "Miércoles",
        "subject": "TÉCNICAS DE SIMULACIÓN",
        "teacher": "CHANCAY GARCIA LEONARDO JAVIER",
        "parallel": "A",
        "classroom": "1-59-2-02-A",
        "location": "Aula (Piso 2)",
        "start_time": "16:00",
        "end_time": "18:00",
    },
    # JUEVES
    {
        "id": "admin_bd_jue",
        "day": 3,
        "day_name": "Jueves",
        "subject": "ADMINISTRACIÓN DE BASES DE DATOS",
        "teacher": "BOWEN MENDOZA LORENA ELIZABETH",
        "parallel": "A",
        "classroom": "1-59-3-02-A",
        "location": "Aula (Piso 3)",
        "start_time": "09:00",
        "end_time": "10:00",
    },
    {
        "id": "calidad_software_jue",
        "day": 3,
        "day_name": "Jueves",
        "subject": "ASEGURAMIENTO DE CALIDAD DEL SOFTWARE",
        "teacher": "CEVALLOS VILLA GUILLERMO JOSE",
        "parallel": "B",
        "classroom": "1-59-2-04-LC",
        "location": "Lab. Computación (Piso 2)",
        "start_time": "16:00",
        "end_time": "18:00",
    },
]


def send_class_notification(c: Dict, minutes_left: int = 30):
    """Envía un recordatorio estético y detallado a ntfy para la próxima clase universitaria."""
    topic = os.environ.get("NTFY_TOPIC", "utm-tareas-randy-az")
    if not topic:
        return

    title = f"Proxima clase en {minutes_left} min: {c['subject'][:35]}"
    body = (
        f"🔔 ¡Tu clase empieza en {minutes_left} minutos!\n\n"
        f"📚 Materia: {c['subject']}\n"
        f"⏰ Horario: {c['start_time']} - {c['end_time']}\n"
        f"🏢 Aula: {c['classroom']}\n"
        f"📍 Ubicación: {c['location']}\n"
        f"👥 Paralelo: {c['parallel']}\n"
        f"👨‍🏫 Docente: {c['teacher']}"
    )

    headers = {
        "Title": title,
        "Priority": "high",
        "Tags": "alarm_clock,mortarboard,books",
        "Content-Type": "text/plain; charset=utf-8",
    }

    try:
        res = requests.post(
            f"https://ntfy.sh/{topic}",
            data=body.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        if res.status_code == 200:
            print(f"[ClassSchedule] Alerta de clase enviada con éxito: {c['subject']} ({c['start_time']})")
        else:
            print(f"[ClassSchedule] Error enviando a ntfy ({res.status_code}): {res.text}")
    except Exception as e:
        print(f"[ClassSchedule] Excepción al enviar alerta de clase: {e}")


def check_and_notify_upcoming_classes(storage):
    """
    Evalúa si alguna clase del día de hoy comienza en aproximadamente 30 minutos
    (ventana de 25 a 35 minutos antes). Si no ha sido notificada hoy, envía el push.
    """
    now_ec = datetime.now(ECUADOR_TZ)
    current_weekday = now_ec.weekday()
    today_str = now_ec.strftime("%Y-%m-%d")

    for c in CLASS_SCHEDULE:
        if c["day"] != current_weekday:
            continue

        try:
            shour, smin = map(int, c["start_time"].split(":"))
            class_start = now_ec.replace(hour=shour, minute=smin, second=0, microsecond=0)
            diff_secs = (class_start - now_ec).total_seconds()
            diff_mins = diff_secs / 60.0

            # Disparar si faltan entre 0 y 32 minutos para el inicio de la clase
            if 0 < diff_mins <= 32:
                task_id = f"class_{c['id']}_{today_str}"
                if not storage.has_notified_milestone(task_id, "30m"):
                    print(f"[{now_ec.strftime('%Y-%m-%d %H:%M:%S')}] 🎓 Clase próxima detectada ({int(diff_mins)} min): {c['subject']}")
                    send_class_notification(c, minutes_left=int(diff_mins))
                    storage.record_milestone(task_id, "30m")
        except Exception as e:
            print(f"[ClassSchedule] Error evaluando clase {c.get('id')}: {e}")


if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        print("Enviando notificación de prueba a ntfy...")
        sample_class = CLASS_SCHEDULE[1]  # Desarrollo Web
        send_class_notification(sample_class, minutes_left=30)
