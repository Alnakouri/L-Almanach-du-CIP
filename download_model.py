import os
from huggingface_hub import login, snapshot_download

def download_gemma():
    # 1. Charger le token depuis le .env
    token = None
    if os.path.exists('.env'):
        with open('.env', 'r') as f:
            for line in f:
                if line.startswith('HF_TOKEN='):
                    token = line.split('=')[1].strip().replace('"', '').replace("'", "")

    if not token or token == "votre_token_ici":
        print("Pas de token : on saute Gemma. (Kokoro n'en a pas besoin.)")
        return False

    print("Connexion a Hugging Face...")
    try:
        login(token=token)
        print("Connecte !")

        print("Telechargement de l'IA Gemma 2B au format transformers.js (env. 1.2 Go)...")
        snapshot_download(
            repo_id='Xenova/gemma-2b-it',
            local_dir='./models/Xenova/gemma-2b-it',
            local_dir_use_symlinks=False,
            allow_patterns=[
                '*.json',
                'tokenizer.model',
                'onnx/*_q4.onnx',
                'onnx/*_q4.onnx_data',
            ]
        )
        print("Gemma OK.")
        return True
    except Exception as e:
        print(f"Erreur Gemma : {e}")
        return False


def download_kokoro():
    print("Telechargement de Kokoro TTS 82M (env. 80 Mo, public, sans token)...")
    try:
        snapshot_download(
            repo_id='onnx-community/Kokoro-82M-v1.0-ONNX',
            local_dir='./models/onnx-community/Kokoro-82M-v1.0-ONNX',
            local_dir_use_symlinks=False,
            allow_patterns=[
                '*.json',
                'tokenizer.json',
                'onnx/model_q8f16.onnx',
                'voices/ff_siwis.bin',
                'voices/af_heart.bin',
                'voices/af_bella.bin',
                'voices/am_michael.bin',
            ]
        )
        print("Kokoro OK.")
        return True
    except Exception as e:
        print(f"Erreur Kokoro : {e}")
        return False


def download():
    gemma_ok = download_gemma()
    kokoro_ok = download_kokoro()

    print()
    print("=" * 60)
    print("Bilan :")
    print(f"  Gemma 2B IT : {'OK' if gemma_ok else 'NON (token manquant ou erreur)'}")
    print(f"  Kokoro TTS  : {'OK' if kokoro_ok else 'ECHEC'}")
    print("=" * 60)

    # 3. Securite : suppression du .env apres succes
    if os.path.exists('.env') and gemma_ok:
        os.remove('.env')
        print("Securite : Le fichier .env a ete supprime automatiquement.")

    print("Vous pouvez maintenant lancer l'Almanach et l'audio sera 100% naturel hors-ligne.")


if __name__ == "__main__":
    download()
