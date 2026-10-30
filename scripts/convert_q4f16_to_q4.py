#!/usr/bin/env python
"""Convertit un ONNX q4f16 (poids int4 + activations/scales/logits float16) en q4 (fp32).

Pourquoi : le format q4f16 est destiné au GPU/WebGPU. Sur le CPU d'onnxruntime-node (process
Electron), le float16 est inutilisable (binding natif 1.21.0 + incompatibilité Float16Array,
cf PLAN v8.2.0). Cette conversion laisse les poids quantifiés int4 (MatMulNBits, uint8) intacts
et ne repasse en fp32 que les tenseurs float16 (scales, constantes, KV-cache, logits). Le
résultat est numériquement >= au q4f16 (fp16 -> fp32 est sans perte) et tourne sur CPU comme le
Qwen base q4.

Usage : python convert_q4f16_to_q4.py <input_q4f16.onnx> <output_q4.onnx>
"""
import sys
import numpy as np
import onnx
from onnx import TensorProto, numpy_helper

FP16 = TensorProto.FLOAT16   # 10
FP32 = TensorProto.FLOAT     # 1


def fix_value_infos(graph):
    n = 0
    for vi in list(graph.input) + list(graph.output) + list(graph.value_info):
        tt = vi.type.tensor_type
        if tt.elem_type == FP16:
            tt.elem_type = FP32
            n += 1
    return n


def fix_nodes(graph):
    casts, consts = 0, 0
    for node in graph.node:
        if node.op_type == "Cast":
            for attr in node.attribute:
                if attr.name == "to" and attr.i == FP16:
                    attr.i = FP32
                    casts += 1
        elif node.op_type == "Constant":
            for attr in node.attribute:
                if attr.name == "value" and attr.t.data_type == FP16:
                    arr = numpy_helper.to_array(attr.t).astype(np.float32)
                    new_t = numpy_helper.from_array(arr, attr.t.name)
                    attr.t.CopyFrom(new_t)
                    consts += 1
        # Recurse into subgraphs (If/Loop/Scan) by walking GRAPH/GRAPHS attributes
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.GRAPH:
                c2, k2 = fix_nodes(attr.g)
                casts += c2
                consts += k2
                fix_value_infos(attr.g)
                fix_initializers(attr.g)
            elif attr.type == onnx.AttributeProto.GRAPHS:
                for sg in attr.graphs:
                    c2, k2 = fix_nodes(sg)
                    casts += c2
                    consts += k2
                    fix_value_infos(sg)
                    fix_initializers(sg)
    return casts, consts


def fix_initializers(graph):
    n = 0
    for init in graph.initializer:
        if init.data_type == FP16:
            arr = numpy_helper.to_array(init).astype(np.float32)
            init.CopyFrom(numpy_helper.from_array(arr, init.name))
            n += 1
    return n


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    print(f"Chargement de {src} ...")
    model = onnx.load(src)  # charge les poids embarqués
    g = model.graph

    ni = fix_initializers(g)
    nvi = fix_value_infos(g)
    nc, nk = fix_nodes(g)
    print(f"  initializers fp16->fp32 : {ni}")
    print(f"  value_info/io fp16->fp32 : {nvi}")
    print(f"  Cast(to=fp16)->fp32      : {nc}")
    print(f"  Constant fp16->fp32      : {nk}")

    onnx.checker.check_model(model, full_check=False)
    print(f"Sauvegarde de {dst} (fichier unique embarqué) ...")
    try:
        onnx.save(model, dst)
    except (ValueError, Exception) as e:  # > 2 Go protobuf -> external data
        print(f"  save embarqué impossible ({e}); fallback external data.")
        import os
        base = os.path.basename(dst)
        onnx.save(model, dst, save_as_external_data=True,
                  all_tensors_to_one_file=True, location=base + ".data")
    print("Termine.")


if __name__ == "__main__":
    main()
