# Changelog

## 0.3.0 – 2026-09-10

- Helles, TV-taugliches Spielinterface mit deutlich größeren offenen Zielzahlen.
- Grafische Dartscheibe mit hervorgehobenen Random-Cricket-Zielen; geschlossene Ziele werden separat markiert.
- Neue Spieler-Karten, aktuelle Drei-Dart-Anzeige und klarer Status für Spieler am Board, Takeout und Synchronisierung.
- Die bestehende Spiel- und Board-Manager-Logik bleibt unverändert.

## 0.2.0 – 2026-09-06

- Standardadresse für Kameras am selben Windows-PC: `http://localhost:3180`; Migration der bisherigen Standardadresse unter Erhalt individueller Adressen.
- Eigener Testmodus ohne Kameras und ohne Board-Verbindungen.
- Vollständige Aufnahmen statt nur des letzten Darts abgleichen; fehlende Zwischenmeldungen nachtragen und Wiederholungen ohne zusätzliche Wertung verarbeiten.
- Geänderte Board-Segmente einschließlich Strafpunkten neu berechnen; lokale Wurfkorrekturen und Streichen einzelner Darts ergänzen.
- Drei-Dart-Grenze auch bei der Wertung durchsetzen; ungültiges Triple Bull entfernen.
- Manuellen Spielerwechsel mit dem Leeren des Boards koordinieren; Duplikate beim Herausziehen und veraltete Socket-Ereignisse abfangen.
- Nach Wiederverbindung, Neuladen oder unklarer Aufnahme eine ausdrückliche Synchronisierung ermöglichen.
- Board-Reset nimmt nur die laufende Aufnahme zurück. Alte Spielstände ohne vollständige Wurfliste werden mit einer sichtbaren Übergangsregel übernommen.
- Adressverarbeitung für WS/WSS, HTTP/HTTPS, eigene Ports und IPv6; Verbindungsdiagnose und Hinweis bei nicht speicherbarem Spielstand.
- Automatisierte Regressionstests ohne zusätzliche Pakete sowie aktualisierte Windows-, Installations- und Testanleitung.
- Browserbedienung mit simuliertem Board geprüft. Praxistest mit Kameras und Installation in Tampermonkey auf der echten Autodarts-Seite stehen aus.

## 0.1.0 – 2026-08-25

- Erste Testversion.
- Sieben zufällige Ziele; Bull immer, nie oder zufällig.
- Zwei bis acht Spieler, Cutthroat-Strafpunkte, Marks und Gewinnerprüfung.
- Verbindung zum lokalen Board Manager über WebSocket.
- Automatischer Spielerwechsel bei `Takeout finished`.
- Undo, manuelle Testwürfe und Overlay auf `play.autodarts.com`.
