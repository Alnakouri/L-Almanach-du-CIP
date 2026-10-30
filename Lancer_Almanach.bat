@echo off
echo Lancement de l'Almanach du CIP...
start "" "http://localhost:8000"
python -m http.server 8000
