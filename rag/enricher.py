"""
rag/enricher.py — 메타데이터 추출 및 그래프 엣지 생성

청크에서 CALLS, USES_TYPE, DEFINED_IN 관계 엣지를 자동 생성한다.
"""

from __future__ import annotations

from rag.models import Chunk, ChunkLevel, GraphEdge, NodeType, RelationType


def enrich_chunk(chunk: Chunk) -> dict:
    """청크에서 인덱싱/저장용 메타데이터 딕셔너리를 추출한다."""
    return chunk.to_metadata()


def build_graph_edges(chunks: list[Chunk]) -> list[GraphEdge]:
    """함수 레벨 청크에서 CALLS, USES_TYPE, DEFINED_IN 엣지를 생성한다."""
    edges: list[GraphEdge] = []
    for chunk in chunks:
        if chunk.level != ChunkLevel.FUNCTION:
            continue
        if chunk.node_type not in (NodeType.FUNCTION, NodeType.METHOD):
            continue

        edges.append(
            GraphEdge(
                source=chunk.name,
                target=chunk.file_path,
                relation=RelationType.DEFINED_IN,
                source_file=chunk.file_path,
            )
        )
        for callee in chunk.called_functions:
            edges.append(
                GraphEdge(
                    source=chunk.name,
                    target=callee,
                    relation=RelationType.CALLS,
                    source_file=chunk.file_path,
                )
            )
        for type_name in chunk.referenced_types:
            edges.append(
                GraphEdge(
                    source=chunk.name,
                    target=type_name,
                    relation=RelationType.USES_TYPE,
                    source_file=chunk.file_path,
                )
            )
    return edges
