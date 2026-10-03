# Changelog

## 0.4.1 – 2026-10-03

- Erste Aufnahme nach bewusstem Start mit leerem Board direkt freigeben und bestehende Board-Verbindung erhalten; bekannte steckende Darts bleiben gesperrt.
- Drei feste Korrekturfelder direkt bei der aktuellen Aufnahme, auch ohne erkannte Darts. Manuelle Ergänzungen und Kamera-Rohliste getrennt abgleichen.
- Zielzahlen absteigend anzeigen, Bull am Ende, auch für gespeicherte Spiele.
- Online-Boardmeldungen pro Aufnahme und Inhalt nur einmal weiterreichen; Rückkopplung zwischen Host und Gast unterbinden.
- Nach Online-Spielerwechsel das leere Board des nächsten Spielers separat bestätigen, damit alte Darts nicht erneut zählen.
- Regressionstests für Startwürfe, manuelle Ergänzungen, spätere Kameraerkennung, Speicherung, Sortierung und Online-Meldungsaustausch ergänzt.

## 0.4.0 – 2026-09-19

- Anzeigename in „Autodarts – Cricket Random Cutthroat“ geändert.
- Private Online-Räume für zwei Spieler mit sechsstelligen Raumcodes ergänzt.
- Direkte, verschlüsselte Browser-zu-Browser-Verbindung über PeerJS/WebRTC; kein eigener Spielserver und normalerweise keine Portfreigabe erforderlich.
- Der Host verwaltet den maßgeblichen Spielstand und synchronisiert Ziele, Marks, Punkte, Würfe, Korrekturen, Spielerwechsel und Takeout-Status.
- Beide Spieler können unabhängig ein eigenes Autodarts-Board oder den Testmodus verwenden; lokale Board-Adresse und Gerätestatus werden nicht überschrieben.
- Wiederverbindung und Versions-/Zustandsreihenfolge abgesichert; bei einer Unterbrechung während eines Board-Zugs wird die Aufnahme vorsichtshalber synchronisiert.
- Online-Protokoll und ungültige beziehungsweise veraltete Zustände durch zusätzliche Regressionstests abgedeckt.

## 0.3.1 – 2026-09-10

- „Vorheriger Spieler“: Die zuletzt abgeschlossene Aufnahme kann wieder geöffnet und korrigiert werden.
- „Würfe zurücksetzen“: Im Testmodus wird die Aufnahme geleert; im Kameramodus wird ihre Wertung zurückgenommen, ohne die physischen Wurfplätze zu verlieren.
- Korrekturen und Undo funktionieren auch im neuen Review-Modus; Board-Ereignisse werden während der Korrektur nicht ungefragt übernommen.

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

